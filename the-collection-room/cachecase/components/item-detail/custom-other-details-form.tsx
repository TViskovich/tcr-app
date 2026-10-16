import { CollapsibleSection } from '@/components/item-detail/collapsible-section';
import { DetailsSectionHeader, DetailsTextField } from '@/components/item-detail/details-form-parts';
import { SelectField } from '@/components/item-detail/select-field';

// Custom Other details (Add Item → Collectible Type "Other" → Category
// "Other" + the collector's own category name). The category can be
// anything, so this is a deliberately small, general form built from the
// same parts as the other category forms: a name (the one required field),
// maker, year, an identifier to search by, and condition.

export const CUSTOM_OTHER_CONDITIONS = ['New', 'Excellent', 'Good', 'Fair', 'Poor'];

export type CustomOtherFormState = {
  name: string;
  brand: string;
  year: string;
  identifier: string;
  condition: string;
  purchasePrice: string;
  estimatedValue: string;
  notes: string;
};

export const INITIAL_CUSTOM_OTHER_FORM: CustomOtherFormState = {
  name: '',
  brand: '',
  year: '',
  identifier: '',
  condition: '',
  purchasePrice: '',
  estimatedValue: '',
  notes: '',
};

export function CustomOtherDetailsForm({
  value,
  onChange,
}: {
  value: CustomOtherFormState;
  onChange: (next: CustomOtherFormState) => void;
}) {
  function set<K extends keyof CustomOtherFormState>(key: K, next: CustomOtherFormState[K]) {
    onChange({ ...value, [key]: next });
  }

  return (
    <>
      <DetailsSectionHeader title="Item Identity" />
      <DetailsTextField label="Item Name" value={value.name} onChange={(v) => set('name', v)} />
      <DetailsTextField
        label="Brand / Maker"
        value={value.brand}
        onChange={(v) => set('brand', v)}
        placeholder="e.g. who made or published it"
      />
      <DetailsTextField
        label="Year"
        value={value.year}
        onChange={(v) => set('year', v)}
        keyboardType="number-pad"
        maxLength={4}
      />
      <DetailsTextField
        label="Identifier (optional)"
        value={value.identifier}
        onChange={(v) => set('identifier', v)}
        placeholder="e.g. serial, model or catalog number"
        autoCapitalize="characters"
        autoCorrect={false}
        hint="A number collectors search by, if it has one."
      />

      <DetailsSectionHeader title="Condition" />
      <SelectField
        label="Condition"
        value={value.condition || null}
        options={CUSTOM_OTHER_CONDITIONS}
        placeholder="Select condition"
        onChange={(v) => set('condition', v)}
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
