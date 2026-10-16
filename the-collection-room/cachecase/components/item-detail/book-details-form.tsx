import { CollapsibleSection } from '@/components/item-detail/collapsible-section';
import {
  DetailsPairField,
  DetailsSectionHeader,
  DetailsTextField,
  DetailsTipCard,
  DetailsToggleRow,
} from '@/components/item-detail/details-form-parts';
import { OptionWithOtherField } from '@/components/item-detail/option-with-other-field';
import { MultiSelectField, SelectField } from '@/components/item-detail/select-field';

// Books details (Add Item → Collectible Type "Other" → Category "Books",
// and Item Detail's edit mode). Saved via create_other_item/
// update_other_item — lib/other-item-books.ts maps this form state.

export const BOOK_EDITIONS = ['First Edition', 'Later Edition', 'Special / Limited Edition'];
export const BOOK_PRINTINGS = ['1st Printing', '2nd Printing', '3rd Printing', '4th Printing', 'Later Printing', 'Unknown'];
export const BOOK_FORMATS = ['Hardcover', 'Trade Paperback', 'Mass Market Paperback', 'Leatherbound'];
export const BOOK_SPECIAL_PUBLISHERS = ['Folio Society', 'Easton Press', 'Subterranean Press', 'Franklin Library', 'Other'];
export const BOOK_DUST_JACKET = ['Present', 'Missing', 'Not Applicable'];
export const BOOK_SIGNATURES = ['Unsigned', 'Signed', 'Flat-Signed (Signature Only)', 'Inscribed', 'Signed Limited Edition'];
// The standard bookseller scale — used as-is, collectors already know it.
export const BOOK_CONDITIONS = ['Fine', 'Near Fine', 'Very Good', 'Good', 'Fair', 'Poor'];
export const BOOK_FLAWS = ['Ex-Library', 'Remainder Mark', 'Foxing', 'Writing / Bookplate', 'Sunned Spine', 'Loose Binding'];

export type BookFormState = {
  title: string;
  author: string;
  illustrator: string;
  publisher: string;
  yearPublished: string;
  isbn: string;
  edition: string;
  printing: string;
  numberLine: string;
  format: string;
  specialPublisher: string;
  limitedNumber: string;
  limitedSize: string;
  bookClubEdition: boolean;
  dustJacket: string;
  priceClipped: boolean;
  jacketCondition: string;
  signature: string;
  associationCopy: boolean;
  associationNotes: string;
  condition: string;
  flaws: string[];
  purchasePrice: string;
  estimatedValue: string;
  notes: string;
};

export const INITIAL_BOOK_FORM: BookFormState = {
  title: '',
  author: '',
  illustrator: '',
  publisher: '',
  yearPublished: '',
  isbn: '',
  edition: '',
  printing: '',
  numberLine: '',
  format: '',
  specialPublisher: '',
  limitedNumber: '',
  limitedSize: '',
  bookClubEdition: false,
  dustJacket: '',
  priceClipped: false,
  jacketCondition: '',
  signature: '',
  associationCopy: false,
  associationNotes: '',
  condition: '',
  flaws: [],
  purchasePrice: '',
  estimatedValue: '',
  notes: '',
};

export function BookDetailsForm({
  value,
  onChange,
}: {
  value: BookFormState;
  onChange: (next: BookFormState) => void;
}) {
  function set<K extends keyof BookFormState>(key: K, next: BookFormState[K]) {
    onChange({ ...value, [key]: next });
  }

  const isSpecial = value.edition === 'Special / Limited Edition';
  const hasJacket = value.dustJacket === 'Present';
  const isSigned = !!value.signature && value.signature !== 'Unsigned';
  const limitedPreview =
    value.limitedNumber.trim() && value.limitedSize.trim()
      ? `Displays as ${value.limitedNumber.trim()}/${value.limitedSize.trim()}`
      : 'e.g. 45 of 500 displays as 45/500';

  return (
    <>
      <DetailsSectionHeader title="Book Identity" />
      <DetailsTextField label="Title" value={value.title} onChange={(v) => set('title', v)} />
      <DetailsTextField label="Author" value={value.author} onChange={(v) => set('author', v)} />
      <DetailsTextField
        label="Illustrator (optional)"
        value={value.illustrator}
        onChange={(v) => set('illustrator', v)}
        hint="Matters for children's and illustrated books."
      />
      <DetailsTextField label="Publisher" value={value.publisher} onChange={(v) => set('publisher', v)} />
      <DetailsTextField
        label="Year Published"
        value={value.yearPublished}
        onChange={(v) => set('yearPublished', v)}
        keyboardType="number-pad"
        maxLength={4}
      />
      <DetailsTextField
        label="ISBN (optional)"
        value={value.isbn}
        onChange={(v) => set('isbn', v)}
        keyboardType="number-pad"
        hint="Most books from before about 1970 don't have one."
      />

      {/* Edition — the biggest value driver. */}
      <DetailsSectionHeader title="Edition" />
      <SelectField
        label="Edition"
        value={value.edition || null}
        options={BOOK_EDITIONS}
        placeholder="Select edition"
        onChange={(v) =>
          onChange({
            ...value,
            edition: v,
            specialPublisher: v === 'Special / Limited Edition' ? value.specialPublisher : '',
            limitedNumber: v === 'Special / Limited Edition' ? value.limitedNumber : '',
            limitedSize: v === 'Special / Limited Edition' ? value.limitedSize : '',
          })
        }
      />
      <SelectField
        label="Printing"
        value={value.printing || null}
        options={BOOK_PRINTINGS}
        placeholder="Select printing"
        onChange={(v) => set('printing', v)}
      />
      <DetailsTextField
        label="Number Line"
        value={value.numberLine}
        onChange={(v) => set('numberLine', v)}
        placeholder="e.g. 10 9 8 7 6 5 4 3 2 1"
        hint="On the copyright page — the lowest number is the printing."
      />
      <SelectField
        label="Format"
        value={value.format || null}
        options={BOOK_FORMATS}
        placeholder="Select format"
        onChange={(v) => set('format', v)}
      />
      {isSpecial && (
        <>
          <OptionWithOtherField
            label="Special Edition Publisher"
            options={BOOK_SPECIAL_PUBLISHERS}
            value={value.specialPublisher}
            onChange={(v) => set('specialPublisher', v)}
            customPlaceholder="Specify publisher"
          />
          <DetailsPairField
            label="Limited Edition Number / Size"
            first={value.limitedNumber}
            second={value.limitedSize}
            onChangeFirst={(v) => set('limitedNumber', v)}
            onChangeSecond={(v) => set('limitedSize', v)}
            firstPlaceholder="No."
            secondPlaceholder="Size"
            separator="/"
            hint={limitedPreview}
          />
        </>
      )}
      <DetailsToggleRow
        label="Book Club Edition (BCE)"
        sublabel="Looks like a first edition but is worth far less"
        value={value.bookClubEdition}
        onChange={(v) => set('bookClubEdition', v)}
      />
      <DetailsTipCard
        title="First edition, first printing"
        body="A first edition, first printing is the main target for collectors — check the number line on the copyright page."
      />

      {/* Dust jacket — can be most of the value on modern firsts. */}
      <DetailsSectionHeader title="Dust Jacket" />
      <SelectField
        label="Dust Jacket"
        value={value.dustJacket || null}
        options={BOOK_DUST_JACKET}
        placeholder="Select dust jacket"
        onChange={(v) =>
          onChange({
            ...value,
            dustJacket: v,
            priceClipped: v === 'Present' ? value.priceClipped : false,
            jacketCondition: v === 'Present' ? value.jacketCondition : '',
          })
        }
      />
      {hasJacket && (
        <>
          <DetailsToggleRow
            label="Price-Clipped"
            sublabel="The price corner has been cut off, which lowers the value"
            value={value.priceClipped}
            onChange={(v) => set('priceClipped', v)}
          />
          <SelectField
            label="Jacket Condition"
            value={value.jacketCondition || null}
            options={BOOK_CONDITIONS}
            placeholder="Select jacket condition"
            onChange={(v) => set('jacketCondition', v)}
          />
        </>
      )}

      <DetailsSectionHeader title="Signature" />
      <SelectField
        label="Signed"
        value={value.signature || null}
        options={BOOK_SIGNATURES}
        placeholder="Select signature"
        onChange={(v) =>
          onChange({
            ...value,
            signature: v,
            associationCopy: v === 'Unsigned' ? false : value.associationCopy,
            associationNotes: v === 'Unsigned' ? '' : value.associationNotes,
          })
        }
      />
      {isSigned && (
        <DetailsToggleRow
          label="Association Copy"
          sublabel="Inscribed to someone notable — adds a lot of value"
          value={value.associationCopy}
          onChange={(v) => onChange({ ...value, associationCopy: v, associationNotes: v ? value.associationNotes : '' })}
        />
      )}
      {isSigned && value.associationCopy && (
        <DetailsTextField
          label="Association Notes"
          value={value.associationNotes}
          onChange={(v) => set('associationNotes', v)}
          placeholder="Who it's inscribed to, and why they matter"
        />
      )}

      <DetailsSectionHeader title="Condition" />
      <SelectField
        label="Book Condition"
        value={value.condition || null}
        options={BOOK_CONDITIONS}
        placeholder="Select condition"
        onChange={(v) => set('condition', v)}
      />
      <MultiSelectField
        label="Flaws"
        values={value.flaws}
        options={BOOK_FLAWS}
        placeholder="No flaws"
        onChange={(v) => set('flaws', v)}
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
