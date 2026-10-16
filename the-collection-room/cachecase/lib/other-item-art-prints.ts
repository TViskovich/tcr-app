import { type ArtPrintFormState, INITIAL_ART_PRINT_FORM } from '@/components/item-detail/art-print-details-form';
import {
  compactDetails,
  detailBool,
  detailText,
  firstIssue,
  moneyText,
  pairLabel,
  parseOptionalDecimal,
  parseOptionalInteger,
  parseOptionalMoney,
  parseOptionalYear,
  requiredText,
  textOrNull,
  textTooLong,
  unspecifiedOption,
  valueRows,
  yearText,
  yesOrNull,
  type OtherCategoryAdapter,
} from '@/lib/other-items';
import type { OtherItemDetails } from '@/types';

// Other → Art & Prints (components/item-detail/art-print-details-form.tsx).
// Shared columns: Title → title (required), Artist → brand (so Search and
// older builds show it), Year Created → year, Estimated Value, Notes →
// description; Purchase Price → private. No search identifier. The rest →
// details ('art_prints' spec in supabase/migrations/
// 20261024120000_add_other_item_details.sql).
//
// Only the fields the form is showing for the chosen Type are saved, using
// the form's own rules: edition details only for prints/posters (or no Type
// yet), edition number/size not for open editions, medium for originals.

const SIZE_MIN = 0.01;
const SIZE_MAX = 10000;

function sections(form: ArtPrintFormState) {
  const isOriginal = form.type === 'Original';
  const showEdition = !isOriginal;
  return { isOriginal, showEdition, showEditionNumbers: showEdition && form.type !== 'Open Edition Print' };
}

export const artPrintAdapter: OtherCategoryAdapter<ArtPrintFormState> = {
  category: 'art_prints',
  initialForm: INITIAL_ART_PRINT_FORM,

  validate(form) {
    const { isOriginal, showEdition, showEditionNumbers } = sections(form);
    return firstIssue(
      requiredText(form.title, 'Title', 'Please enter the title of the artwork.'),
      textTooLong(form.artist, 200, 'Artist'),
      parseOptionalYear(form.yearCreated, 'Year Created').issue,
      !isOriginal ? parseOptionalYear(form.printYear, 'Print Year').issue : null,
      showEdition ? unspecifiedOption(form.printMethod, 'Print Method') : null,
      showEditionNumbers ? parseOptionalInteger(form.editionNumber, 'Edition Number').issue : null,
      showEditionNumbers ? parseOptionalInteger(form.editionSize, 'Edition Size').issue : null,
      showEdition ? textTooLong(form.publisher, 120, 'Publisher / Release') : null,
      isOriginal ? unspecifiedOption(form.medium, 'Medium') : null,
      parseOptionalDecimal(form.imageWidth, 'Image Width', SIZE_MIN, SIZE_MAX).issue,
      parseOptionalDecimal(form.imageHeight, 'Image Height', SIZE_MIN, SIZE_MAX).issue,
      parseOptionalDecimal(form.paperWidth, `${isOriginal ? 'Canvas' : 'Paper'} Width`, SIZE_MIN, SIZE_MAX).issue,
      parseOptionalDecimal(form.paperHeight, `${isOriginal ? 'Canvas' : 'Paper'} Height`, SIZE_MIN, SIZE_MAX).issue,
      parseOptionalMoney(form.purchasePrice, 'Purchase Price').issue,
      parseOptionalMoney(form.estimatedValue, 'Estimated Value').issue,
    );
  },

  toFields(form) {
    const { isOriginal, showEdition, showEditionNumbers } = sections(form);
    const size = (v: string) => parseOptionalDecimal(v, '', SIZE_MIN, SIZE_MAX).value;
    const dims = {
      image_width: size(form.imageWidth),
      image_height: size(form.imageHeight),
      paper_width: size(form.paperWidth),
      paper_height: size(form.paperHeight),
    };
    const hasDims = Object.values(dims).some((v) => v != null);
    return {
      title: form.title.trim(),
      brand: textOrNull(form.artist),
      year: parseOptionalYear(form.yearCreated, 'Year Created').value,
      estimatedValue: parseOptionalMoney(form.estimatedValue, 'Estimated Value').value,
      description: textOrNull(form.notes),
      searchIdentifier: null,
      purchasePrice: parseOptionalMoney(form.purchasePrice, 'Purchase Price').value,
      details: compactDetails({
        type: form.type,
        print_year: !isOriginal ? parseOptionalYear(form.printYear, 'Print Year').value : null,
        print_method: showEdition ? form.printMethod : null,
        edition_number: showEditionNumbers ? parseOptionalInteger(form.editionNumber, '').value : null,
        edition_size: showEditionNumbers ? parseOptionalInteger(form.editionSize, '').value : null,
        edition_variant: showEdition ? form.editionVariant : null,
        publisher: showEdition ? form.publisher : null,
        signature: form.signature,
        hand_numbered: form.handNumbered,
        remarque: form.remarque,
        medium: isOriginal ? form.medium : null,
        // Units only mean something alongside a measurement.
        units: hasDims ? form.units : null,
        ...dims,
        framing: form.framing,
      }),
    };
  },

  fromItem(item, details, privateDetails) {
    return {
      artist: item.brand ?? '',
      title: item.title ?? '',
      yearCreated: yearText(item.year),
      printYear: detailText(details, 'print_year'),
      type: detailText(details, 'type'),
      printMethod: detailText(details, 'print_method'),
      editionNumber: detailText(details, 'edition_number'),
      editionSize: detailText(details, 'edition_size'),
      editionVariant: detailText(details, 'edition_variant'),
      publisher: detailText(details, 'publisher'),
      signature: detailText(details, 'signature'),
      handNumbered: detailBool(details, 'hand_numbered'),
      remarque: detailBool(details, 'remarque'),
      medium: detailText(details, 'medium'),
      units: detailText(details, 'units') || INITIAL_ART_PRINT_FORM.units,
      imageWidth: detailText(details, 'image_width'),
      imageHeight: detailText(details, 'image_height'),
      paperWidth: detailText(details, 'paper_width'),
      paperHeight: detailText(details, 'paper_height'),
      framing: detailText(details, 'framing'),
      purchasePrice: moneyText(privateDetails?.purchase_price),
      estimatedValue: moneyText(item.estimated_value),
      notes: item.description ?? '',
    };
  },

  // Title, then the artist and year, then the type with its edition.
  identity(item, details) {
    const artistYear = [item.brand, item.year != null ? String(item.year) : null].filter(Boolean).join(' · ') || null;
    const edition = editionLabel(details);
    const typeLine = [detailText(details, 'type'), edition].filter(Boolean).join(' · ') || null;
    return { title: item.title?.trim() || 'Untitled Item', subtitleLines: [artistYear, typeLine] };
  },

  metadataRows(item, details, privateDetails) {
    const units = detailText(details, 'units');
    const isOriginal = detailText(details, 'type') === 'Original';
    const dims = (w: string, h: string) => {
      const label = pairLabel(detailText(details, w), detailText(details, h), ' × ');
      return label && units ? `${label} ${units}` : label;
    };
    return [
      { label: 'Artist', value: item.brand },
      { label: 'Title', value: item.title },
      { label: 'Year Created', value: yearText(item.year) },
      { label: 'Type', value: detailText(details, 'type') },
      { label: 'Edition', value: editionLabel(details) },
      { label: 'Print Year', value: detailText(details, 'print_year') },
      { label: 'Print Method', value: detailText(details, 'print_method') },
      { label: 'Edition Variant', value: detailText(details, 'edition_variant') },
      { label: 'Publisher / Release', value: detailText(details, 'publisher') },
      { label: 'Signed', value: detailText(details, 'signature') },
      { label: 'Hand-Numbered', value: yesOrNull(detailBool(details, 'hand_numbered')) },
      { label: 'Remarque', value: yesOrNull(detailBool(details, 'remarque')) },
      { label: 'Medium', value: detailText(details, 'medium') },
      { label: 'Image Size', value: dims('image_width', 'image_height') },
      { label: `${isOriginal ? 'Canvas' : 'Paper'} Size`, value: dims('paper_width', 'paper_height') },
      { label: 'Framed', value: detailText(details, 'framing') },
      ...valueRows(item, privateDetails),
    ];
  },
};

function editionLabel(details: OtherItemDetails | null): string | null {
  return pairLabel(detailText(details, 'edition_number'), detailText(details, 'edition_size'), '/');
}
