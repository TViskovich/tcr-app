import { CollapsibleSection } from '@/components/item-detail/collapsible-section';
import {
  DetailsPairField,
  DetailsSectionHeader,
  DetailsTextField,
  DetailsTipCard,
  DetailsToggleRow,
} from '@/components/item-detail/details-form-parts';
import { OptionWithOtherField } from '@/components/item-detail/option-with-other-field';
import { SelectField } from '@/components/item-detail/select-field';

// Art & Prints details (Add Item → Collectible Type "Other" → Category
// "Art & Prints", and Item Detail's edit mode). Saved via
// create_other_item/update_other_item — lib/other-item-art-prints.ts maps
// this form state, saving only the sections shown. Sections adapt to Type: edition details for prints/posters only,
// edition number/size not for open editions, medium for originals only.

export const ART_TYPES = ['Original', 'Limited Edition Print', 'Open Edition Print', 'Poster'];
export const ART_PRINT_METHODS = ['Screen Print', 'Giclée', 'Lithograph', 'Etching', 'Woodcut', 'Offset', 'Other'];
export const ART_EDITION_VARIANTS = ['Regular', 'Variant', "AP (Artist's Proof)", "PP (Printer's Proof)", 'Test Print'];
// Kept as three separate options: plate-signed (printed) is often mistaken
// for a real signature.
export const ART_SIGNATURES = ['Hand-Signed', 'Plate-Signed (Printed)', 'Unsigned'];
export const ART_MEDIUMS = ['Oil', 'Acrylic', 'Watercolor', 'Ink', 'Digital', 'Other'];
export const ART_UNITS = ['in', 'cm'];
export const ART_FRAMING = ['Unframed', 'Framed', 'Framed with Archival / UV Glass'];

export type ArtPrintFormState = {
  artist: string;
  title: string;
  yearCreated: string;
  printYear: string;
  type: string;
  printMethod: string;
  editionNumber: string;
  editionSize: string;
  editionVariant: string;
  publisher: string;
  signature: string;
  handNumbered: boolean;
  remarque: boolean;
  medium: string;
  units: string;
  imageWidth: string;
  imageHeight: string;
  paperWidth: string;
  paperHeight: string;
  framing: string;
  purchasePrice: string;
  estimatedValue: string;
  notes: string;
};

export const INITIAL_ART_PRINT_FORM: ArtPrintFormState = {
  artist: '',
  title: '',
  yearCreated: '',
  printYear: '',
  type: '',
  printMethod: '',
  editionNumber: '',
  editionSize: '',
  editionVariant: '',
  publisher: '',
  signature: '',
  handNumbered: false,
  remarque: false,
  medium: '',
  units: 'in',
  imageWidth: '',
  imageHeight: '',
  paperWidth: '',
  paperHeight: '',
  framing: '',
  purchasePrice: '',
  estimatedValue: '',
  notes: '',
};

export function ArtPrintDetailsForm({
  value,
  onChange,
}: {
  value: ArtPrintFormState;
  onChange: (next: ArtPrintFormState) => void;
}) {
  function set<K extends keyof ArtPrintFormState>(key: K, next: ArtPrintFormState[K]) {
    onChange({ ...value, [key]: next });
  }

  const isOriginal = value.type === 'Original';
  const showEdition = !isOriginal;
  const showEditionNumbers = showEdition && value.type !== 'Open Edition Print';
  const editionPreview =
    value.editionNumber.trim() && value.editionSize.trim()
      ? `Displays as ${value.editionNumber.trim()}/${value.editionSize.trim()}`
      : 'e.g. 23 of 100 displays as 23/100';
  const isPaper = !isOriginal;

  return (
    <>
      <DetailsSectionHeader title="Artwork Identity" />
      <DetailsTextField label="Artist" value={value.artist} onChange={(v) => set('artist', v)} />
      <DetailsTextField label="Title" value={value.title} onChange={(v) => set('title', v)} />
      <DetailsTextField
        label="Year Created"
        value={value.yearCreated}
        onChange={(v) => set('yearCreated', v)}
        keyboardType="number-pad"
        maxLength={4}
      />
      {!isOriginal && (
        <DetailsTextField
          label="Print Year (if different)"
          value={value.printYear}
          onChange={(v) => set('printYear', v)}
          keyboardType="number-pad"
          maxLength={4}
        />
      )}
      <SelectField
        label="Type"
        value={value.type || null}
        options={ART_TYPES}
        placeholder="Select type"
        onChange={(v) => set('type', v)}
      />

      {showEdition && (
        <>
          {/* Edition details drive the value of prints. */}
          <DetailsSectionHeader title="Edition Details" />
          <OptionWithOtherField
            label="Print Method"
            options={ART_PRINT_METHODS}
            value={value.printMethod}
            onChange={(v) => set('printMethod', v)}
            customPlaceholder="Specify print method"
          />
          {showEditionNumbers && (
            <DetailsPairField
              label="Edition Number / Size"
              first={value.editionNumber}
              second={value.editionSize}
              onChangeFirst={(v) => set('editionNumber', v)}
              onChangeSecond={(v) => set('editionSize', v)}
              firstPlaceholder="No."
              secondPlaceholder="Size"
              separator="/"
              hint={editionPreview}
            />
          )}
          <SelectField
            label="Edition Variant"
            value={value.editionVariant || null}
            options={ART_EDITION_VARIANTS}
            placeholder="Select variant"
            onChange={(v) => set('editionVariant', v)}
          />
          <DetailsTextField
            label="Publisher / Release"
            value={value.publisher}
            onChange={(v) => set('publisher', v)}
            placeholder="e.g. Mondo, Bottleneck Gallery, a shop drop"
            hint="Gig poster and pop culture print collectors search by publisher."
          />
          <DetailsTipCard
            title="Proofs and variants"
            body="APs (artist's proofs) and variants often sell for more than the regular edition."
          />
        </>
      )}

      <DetailsSectionHeader title="Signature" />
      <SelectField
        label="Signed"
        value={value.signature || null}
        options={ART_SIGNATURES}
        placeholder="Select signature"
        onChange={(v) => set('signature', v)}
      />
      <DetailsToggleRow
        label="Hand-Numbered"
        sublabel="The edition number is written by hand"
        value={value.handNumbered}
        onChange={(v) => set('handNumbered', v)}
      />
      <DetailsToggleRow
        label="Remarque"
        sublabel="A small original drawing added by the artist — adds a lot of value"
        value={value.remarque}
        onChange={(v) => set('remarque', v)}
      />

      <DetailsSectionHeader title="Physical" />
      {isOriginal && (
        <OptionWithOtherField
          label="Medium"
          options={ART_MEDIUMS}
          value={value.medium}
          onChange={(v) => set('medium', v)}
          customPlaceholder="Specify medium"
        />
      )}
      <SelectField
        label="Units"
        value={value.units}
        options={ART_UNITS}
        onChange={(v) => set('units', v)}
        inline
      />
      <DetailsPairField
        label={`Image Size (${value.units})`}
        first={value.imageWidth}
        second={value.imageHeight}
        onChangeFirst={(v) => set('imageWidth', v)}
        onChangeSecond={(v) => set('imageHeight', v)}
        firstPlaceholder="Width"
        secondPlaceholder="Height"
        separator="×"
        keyboardType="decimal-pad"
      />
      <DetailsPairField
        label={`${isPaper ? 'Paper' : 'Canvas'} Size (${value.units})`}
        first={value.paperWidth}
        second={value.paperHeight}
        onChangeFirst={(v) => set('paperWidth', v)}
        onChangeSecond={(v) => set('paperHeight', v)}
        firstPlaceholder="Width"
        secondPlaceholder="Height"
        separator="×"
        keyboardType="decimal-pad"
      />
      <SelectField
        label="Framed"
        value={value.framing || null}
        options={ART_FRAMING}
        placeholder="Select framing"
        onChange={(v) => set('framing', v)}
      />

      <CollapsibleSection title="Optional Details">
        <DetailsTextField
          label="Purchase Price ($)"
          value={value.purchasePrice}
          onChange={(v) => set('purchasePrice', v)}
          keyboardType="decimal-pad"
        />
        <DetailsTextField
          label="Estimated Value ($)"
          value={value.estimatedValue}
          onChange={(v) => set('estimatedValue', v)}
          keyboardType="decimal-pad"
        />
        <DetailsTextField label="Notes" value={value.notes} onChange={(v) => set('notes', v)} multiline />
      </CollapsibleSection>
    </>
  );
}
