import { type BookFormState, INITIAL_BOOK_FORM } from '@/components/item-detail/book-details-form';
import {
  compactDetails,
  detailBool,
  detailList,
  detailText,
  firstIssue,
  moneyText,
  pairLabel,
  parseOptionalInteger,
  parseOptionalMoney,
  parseOptionalYear,
  requiredText,
  SEARCH_IDENTIFIER_MAX,
  textOrNull,
  textTooLong,
  unspecifiedOption,
  valueRows,
  yearText,
  yesOrNull,
  type OtherCategoryAdapter,
} from '@/lib/other-items';

// Other → Books (components/item-detail/book-details-form.tsx). Shared
// columns: Title → title (required), Author → brand (so Search and older
// builds show it), Year Published → year, Estimated Value, Notes →
// description; ISBN → search_identifier; Purchase Price → private. The
// rest → details ('books' spec in supabase/migrations/
// 20261024120000_add_other_item_details.sql).
//
// Only the fields the form is showing are saved, with the form's own rules:
// special-edition publisher and limited number/size for special editions,
// price-clipped and jacket condition with a jacket present, association
// copy for signed books and its notes when it's an association copy.

function sections(form: BookFormState) {
  const isSigned = !!form.signature && form.signature !== 'Unsigned';
  return {
    isSpecial: form.edition === 'Special / Limited Edition',
    hasJacket: form.dustJacket === 'Present',
    isSigned,
    isAssociation: isSigned && form.associationCopy,
  };
}

export const bookAdapter: OtherCategoryAdapter<BookFormState> = {
  category: 'books',
  initialForm: INITIAL_BOOK_FORM,

  validate(form) {
    const s = sections(form);
    return firstIssue(
      requiredText(form.title, 'Title', 'Please enter the book title.'),
      s.isSpecial ? unspecifiedOption(form.specialPublisher, 'Special Edition Publisher') : null,
      textTooLong(form.isbn, SEARCH_IDENTIFIER_MAX, 'ISBN'),
      textTooLong(form.author, 200, 'Author'),
      textTooLong(form.illustrator, 120, 'Illustrator'),
      textTooLong(form.publisher, 120, 'Publisher'),
      textTooLong(form.numberLine, 60, 'Number Line'),
      s.isAssociation ? textTooLong(form.associationNotes, 500, 'Association Notes') : null,
      parseOptionalYear(form.yearPublished, 'Year Published').issue,
      s.isSpecial ? parseOptionalInteger(form.limitedNumber, 'Limited Edition Number').issue : null,
      s.isSpecial ? parseOptionalInteger(form.limitedSize, 'Limited Edition Size').issue : null,
      parseOptionalMoney(form.purchasePrice, 'Purchase Price').issue,
      parseOptionalMoney(form.estimatedValue, 'Estimated Value').issue,
    );
  },

  toFields(form) {
    const s = sections(form);
    return {
      title: form.title.trim(),
      brand: textOrNull(form.author),
      year: parseOptionalYear(form.yearPublished, 'Year Published').value,
      estimatedValue: parseOptionalMoney(form.estimatedValue, 'Estimated Value').value,
      description: textOrNull(form.notes),
      searchIdentifier: textOrNull(form.isbn),
      purchasePrice: parseOptionalMoney(form.purchasePrice, 'Purchase Price').value,
      details: compactDetails({
        illustrator: form.illustrator,
        publisher: form.publisher,
        edition: form.edition,
        printing: form.printing,
        number_line: form.numberLine,
        format: form.format,
        special_publisher: s.isSpecial ? form.specialPublisher : null,
        limited_number: s.isSpecial ? parseOptionalInteger(form.limitedNumber, '').value : null,
        limited_size: s.isSpecial ? parseOptionalInteger(form.limitedSize, '').value : null,
        book_club_edition: form.bookClubEdition,
        dust_jacket: form.dustJacket,
        price_clipped: s.hasJacket ? form.priceClipped : null,
        jacket_condition: s.hasJacket ? form.jacketCondition : null,
        signature: form.signature,
        association_copy: s.isSigned ? form.associationCopy : null,
        association_notes: s.isAssociation ? form.associationNotes : null,
        condition: form.condition,
        flaws: form.flaws,
      }),
    };
  },

  fromItem(item, details, privateDetails) {
    return {
      title: item.title ?? '',
      author: item.brand ?? '',
      illustrator: detailText(details, 'illustrator'),
      publisher: detailText(details, 'publisher'),
      yearPublished: yearText(item.year),
      isbn: details?.search_identifier ?? '',
      edition: detailText(details, 'edition'),
      printing: detailText(details, 'printing'),
      numberLine: detailText(details, 'number_line'),
      format: detailText(details, 'format'),
      specialPublisher: detailText(details, 'special_publisher'),
      limitedNumber: detailText(details, 'limited_number'),
      limitedSize: detailText(details, 'limited_size'),
      bookClubEdition: detailBool(details, 'book_club_edition'),
      dustJacket: detailText(details, 'dust_jacket'),
      priceClipped: detailBool(details, 'price_clipped'),
      jacketCondition: detailText(details, 'jacket_condition'),
      signature: detailText(details, 'signature'),
      associationCopy: detailBool(details, 'association_copy'),
      associationNotes: detailText(details, 'association_notes'),
      condition: detailText(details, 'condition'),
      flaws: detailList(details, 'flaws'),
      purchasePrice: moneyText(privateDetails?.purchase_price),
      estimatedValue: moneyText(item.estimated_value),
      notes: item.description ?? '',
    };
  },

  // Title, then author, then publisher · year, then edition / printing.
  identity(item, details) {
    const publisherYear =
      [detailText(details, 'publisher'), item.year != null ? String(item.year) : null].filter(Boolean).join(' · ') ||
      null;
    const editionLine =
      [detailText(details, 'edition'), detailText(details, 'printing')].filter(Boolean).join(', ') || null;
    return { title: item.title?.trim() || 'Untitled Item', subtitleLines: [item.brand, publisherYear, editionLine] };
  },

  metadataRows(item, details, privateDetails) {
    return [
      { label: 'Title', value: item.title },
      { label: 'Author', value: item.brand },
      { label: 'Illustrator', value: detailText(details, 'illustrator') },
      { label: 'Publisher', value: detailText(details, 'publisher') },
      { label: 'Year Published', value: yearText(item.year) },
      { label: 'ISBN', value: details?.search_identifier ?? null },
      { label: 'Edition', value: detailText(details, 'edition') },
      { label: 'Printing', value: detailText(details, 'printing') },
      { label: 'Number Line', value: detailText(details, 'number_line') },
      { label: 'Format', value: detailText(details, 'format') },
      { label: 'Special Edition Publisher', value: detailText(details, 'special_publisher') },
      {
        label: 'Limited Edition',
        value: pairLabel(detailText(details, 'limited_number'), detailText(details, 'limited_size'), '/'),
      },
      { label: 'Book Club Edition', value: yesOrNull(detailBool(details, 'book_club_edition')) },
      { label: 'Dust Jacket', value: detailText(details, 'dust_jacket') },
      { label: 'Price-Clipped', value: yesOrNull(detailBool(details, 'price_clipped')) },
      { label: 'Jacket Condition', value: detailText(details, 'jacket_condition') },
      { label: 'Signed', value: detailText(details, 'signature') },
      { label: 'Association Copy', value: yesOrNull(detailBool(details, 'association_copy')) },
      { label: 'Association Notes', value: detailText(details, 'association_notes') },
      { label: 'Condition', value: detailText(details, 'condition') },
      { label: 'Flaws', value: detailList(details, 'flaws').join(', ') },
      ...valueRows(item, privateDetails),
    ];
  },
};
