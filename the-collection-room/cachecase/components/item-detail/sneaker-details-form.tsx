import { CollapsibleSection } from '@/components/item-detail/collapsible-section';
import {
  DetailsSectionHeader,
  DetailsTextField,
  DetailsTipCard,
  DetailsToggleRow,
} from '@/components/item-detail/details-form-parts';
import { OptionWithOtherField } from '@/components/item-detail/option-with-other-field';
import { MultiSelectField, SelectField } from '@/components/item-detail/select-field';

// Sneakers details (Add Item → Collectible Type "Other" → Category
// "Sneakers", and Item Detail's edit mode for a saved sneaker). Saved via
// create_other_item/update_other_item — lib/other-item-sneakers.ts maps
// this form state to the shared columns and the details JSON.

export const SNEAKER_BRAND_OPTIONS = [
  'Nike',
  'Jordan',
  'Adidas',
  'New Balance',
  'Yeezy',
  'ASICS',
  'Puma',
  'Reebok',
  'Converse',
  'Vans',
  'Other',
];
export const SNEAKER_SIZE_SYSTEMS = ["US Men's", "US Women's", 'GS / Youth', 'UK', 'EU'];
export const SNEAKER_CONDITIONS = ['Deadstock (DS)', 'Very Near Deadstock (VNDS)', 'Used'];
export const SNEAKER_CONDITION_SCORES = ['10', '9', '8', '7', '6', '5', '4', '3', '2', '1'];
export const SNEAKER_BOX_OPTIONS = ['Original Box', 'Damaged Box', 'Replacement Box', 'No Box'];
export const SNEAKER_EXTRAS = ['Extra Laces', 'Hangtag', 'Receipt', 'Special Packaging'];
export const SNEAKER_AUTHENTICATORS = ['StockX', 'GOAT', 'CheckCheck', 'Legit App', 'Not Authenticated', 'Other'];

export type SneakerFormState = {
  brand: string;
  model: string;
  colorway: string;
  styleCode: string;
  releaseYear: string;
  size: string;
  sizeSystem: string;
  condition: string;
  conditionScore: string;
  box: string;
  extras: string[];
  authenticatedBy: string;
  authTagOrReceipt: string;
  collabPartner: string;
  limitedRelease: boolean;
  purchasePrice: string;
  estimatedValue: string;
  notes: string;
};

export const INITIAL_SNEAKER_FORM: SneakerFormState = {
  brand: '',
  model: '',
  colorway: '',
  styleCode: '',
  releaseYear: '',
  size: '',
  sizeSystem: '',
  condition: '',
  conditionScore: '',
  box: '',
  extras: [],
  authenticatedBy: '',
  authTagOrReceipt: '',
  collabPartner: '',
  limitedRelease: false,
  purchasePrice: '',
  estimatedValue: '',
  notes: '',
};

export function SneakerDetailsForm({
  value,
  onChange,
}: {
  value: SneakerFormState;
  onChange: (next: SneakerFormState) => void;
}) {
  function set<K extends keyof SneakerFormState>(key: K, next: SneakerFormState[K]) {
    onChange({ ...value, [key]: next });
  }

  const isUsed = value.condition === 'Used';
  const isAuthenticated = !!value.authenticatedBy && value.authenticatedBy !== 'Not Authenticated';

  return (
    <>
      <DetailsSectionHeader title="Sneaker Identity" />
      <OptionWithOtherField
        label="Brand"
        options={SNEAKER_BRAND_OPTIONS}
        value={value.brand}
        onChange={(v) => set('brand', v)}
        customPlaceholder="Specify brand"
      />
      <DetailsTextField
        label="Model"
        value={value.model}
        onChange={(v) => set('model', v)}
        placeholder="e.g. Air Jordan 1 High, Dunk Low"
      />
      <DetailsTextField
        label="Colorway / Nickname"
        value={value.colorway}
        onChange={(v) => set('colorway', v)}
        placeholder="e.g. Chicago, Panda, Travis Scott Mocha"
        hint="Collectors search by this name more than anything else."
      />
      <DetailsTextField
        label="Style Code / SKU"
        value={value.styleCode}
        onChange={(v) => set('styleCode', v)}
        placeholder="e.g. DZ5485-612"
        autoCapitalize="characters"
        autoCorrect={false}
        hint="Printed on the box label and the tag inside the shoe."
      />
      <DetailsTextField
        label="Release Year"
        value={value.releaseYear}
        onChange={(v) => set('releaseYear', v)}
        keyboardType="number-pad"
        maxLength={4}
      />

      {/* Size — the system is explicit, since men's/women's mix-ups are a
          classic source of disputes. */}
      <DetailsSectionHeader title="Size" />
      <DetailsTextField
        label="Size"
        value={value.size}
        onChange={(v) => set('size', v)}
        placeholder="e.g. 10.5"
        keyboardType="decimal-pad"
      />
      <SelectField
        label="Size System"
        value={value.sizeSystem || null}
        options={SNEAKER_SIZE_SYSTEMS}
        placeholder="Select size system"
        onChange={(v) => set('sizeSystem', v)}
      />

      <DetailsSectionHeader title="Condition" />
      <SelectField
        label="Condition"
        value={value.condition || null}
        options={SNEAKER_CONDITIONS}
        placeholder="Select condition"
        onChange={(v) => onChange({ ...value, condition: v, conditionScore: v === 'Used' ? value.conditionScore : '' })}
      />
      {isUsed && (
        <SelectField
          label="Condition Score (1–10)"
          value={value.conditionScore || null}
          options={SNEAKER_CONDITION_SCORES}
          placeholder="Select score"
          onChange={(v) => set('conditionScore', v)}
          scrollable
        />
      )}
      <SelectField
        label="Box"
        value={value.box || null}
        options={SNEAKER_BOX_OPTIONS}
        placeholder="Select box"
        onChange={(v) => set('box', v)}
      />
      <MultiSelectField
        label="Extras"
        values={value.extras}
        options={SNEAKER_EXTRAS}
        placeholder="Select extras"
        onChange={(v) => set('extras', v)}
      />

      <DetailsSectionHeader title="Authentication" />
      <OptionWithOtherField
        label="Authenticated By"
        options={SNEAKER_AUTHENTICATORS}
        value={value.authenticatedBy}
        onChange={(v) =>
          onChange({ ...value, authenticatedBy: v, authTagOrReceipt: v === 'Not Authenticated' ? '' : value.authTagOrReceipt })
        }
        customPlaceholder="Specify service"
      />
      {isAuthenticated && (
        <DetailsTextField
          label="Tag / Receipt Number"
          value={value.authTagOrReceipt}
          onChange={(v) => set('authTagOrReceipt', v)}
          autoCorrect={false}
        />
      )}
      <DetailsTipCard
        title="Photo checklist"
        body="Add photos of both sides, the sole, the insole, the size tag and the box label — they make fakes much easier to spot."
      />

      <CollapsibleSection title="Optional Details">
        <DetailsTextField
          label="Collab Partner"
          value={value.collabPartner}
          onChange={(v) => set('collabPartner', v)}
          placeholder="e.g. Travis Scott, Off-White, Union"
        />
        <DetailsToggleRow
          label="Limited / Regional Release"
          sublabel="Released in limited numbers or only in certain regions"
          value={value.limitedRelease}
          onChange={(v) => set('limitedRelease', v)}
        />
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
