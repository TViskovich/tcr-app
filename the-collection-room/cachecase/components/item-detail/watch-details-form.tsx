import { CollapsibleSection } from '@/components/item-detail/collapsible-section';
import {
  DetailsSectionHeader,
  DetailsTextField,
  DetailsTipCard,
  DetailsToggleRow,
} from '@/components/item-detail/details-form-parts';
import { OptionWithOtherField } from '@/components/item-detail/option-with-other-field';
import { MultiSelectField, SelectField } from '@/components/item-detail/select-field';

// Watches details (Add Item → Collectible Type "Other" → Category
// "Watches", and Item Detail's edit mode for a saved watch). Saved via
// create_other_item/update_other_item — lib/other-item-watches.ts maps this
// form state to the shared columns and the details JSON.

export const WATCH_BRAND_OPTIONS = [
  'Rolex',
  'Omega',
  'Seiko',
  'Grand Seiko',
  'Patek Philippe',
  'Audemars Piguet',
  'Cartier',
  'Tudor',
  'TAG Heuer',
  'Breitling',
  'IWC',
  'Other',
];
export const WATCH_CASE_MATERIALS = [
  'Stainless Steel',
  'Yellow Gold',
  'White Gold',
  'Rose Gold',
  'Two-Tone',
  'Titanium',
  'Ceramic',
  'Platinum',
  'Other',
];
export const WATCH_MOVEMENTS = ['Automatic', 'Manual', 'Quartz'];
export const WATCH_BRACELETS = ['Metal Bracelet', 'Leather Strap', 'Rubber Strap', 'NATO / Fabric Strap', 'Other'];
export const WATCH_CONDITIONS = ['Unworn', 'Excellent', 'Very Good', 'Good', 'Fair'];
export const WATCH_POLISH_OPTIONS = ['Unpolished', 'Polished', 'Unknown'];
export const WATCH_BOX_AND_PAPERS = ['Full Set', 'Watch + Papers', 'Watch + Box', 'Watch Only'];
// Parts that are aftermarket (not original). None selected = all original.
export const WATCH_AFTERMARKET_PARTS = ['Dial', 'Bezel', 'Bracelet', 'Hands', 'Crystal', 'Crown'];

export type WatchFormState = {
  brand: string;
  model: string;
  referenceNumber: string;
  year: string;
  nickname: string;
  caseSize: string;
  caseMaterial: string;
  dial: string;
  movement: string;
  caliber: string;
  bracelet: string;
  condition: string;
  polish: string;
  boxAndPapers: string;
  warrantyCardDate: string;
  lastServiceDate: string;
  servicedBy: string;
  originalPartsKeptAtService: boolean;
  aftermarketParts: string[];
  purchasePrice: string;
  estimatedValue: string;
  notes: string;
};

export const INITIAL_WATCH_FORM: WatchFormState = {
  brand: '',
  model: '',
  referenceNumber: '',
  year: '',
  nickname: '',
  caseSize: '',
  caseMaterial: '',
  dial: '',
  movement: '',
  caliber: '',
  bracelet: '',
  condition: '',
  polish: '',
  boxAndPapers: '',
  warrantyCardDate: '',
  lastServiceDate: '',
  servicedBy: '',
  originalPartsKeptAtService: false,
  aftermarketParts: [],
  purchasePrice: '',
  estimatedValue: '',
  notes: '',
};

export function WatchDetailsForm({
  value,
  onChange,
}: {
  value: WatchFormState;
  onChange: (next: WatchFormState) => void;
}) {
  function set<K extends keyof WatchFormState>(key: K, next: WatchFormState[K]) {
    onChange({ ...value, [key]: next });
  }

  return (
    <>
      <DetailsSectionHeader title="Watch Identity" />
      <OptionWithOtherField
        label="Brand"
        options={WATCH_BRAND_OPTIONS}
        value={value.brand}
        onChange={(v) => set('brand', v)}
        customPlaceholder="Specify brand"
      />
      <DetailsTextField
        label="Model / Line"
        value={value.model}
        onChange={(v) => set('model', v)}
        placeholder="e.g. Submariner, Speedmaster, Daytona"
      />
      <DetailsTextField
        label="Reference Number"
        value={value.referenceNumber}
        onChange={(v) => set('referenceNumber', v)}
        placeholder="e.g. 126610LN"
        autoCapitalize="characters"
        autoCorrect={false}
        hint="The watch world's style code — serious collectors search by it."
      />
      <DetailsTextField
        label="Year"
        value={value.year}
        onChange={(v) => set('year', v)}
        keyboardType="number-pad"
        maxLength={4}
        hint="Year of manufacture, or the year on the papers."
      />
      <DetailsTextField
        label="Nickname"
        value={value.nickname}
        onChange={(v) => set('nickname', v)}
        placeholder="e.g. Pepsi, Hulk, Batman"
      />

      <DetailsSectionHeader title="Specs" />
      <DetailsTextField
        label="Case Size (mm)"
        value={value.caseSize}
        onChange={(v) => set('caseSize', v)}
        placeholder="e.g. 41"
        keyboardType="decimal-pad"
      />
      <OptionWithOtherField
        label="Case Material"
        options={WATCH_CASE_MATERIALS}
        value={value.caseMaterial}
        onChange={(v) => set('caseMaterial', v)}
        customPlaceholder="Specify material"
      />
      <DetailsTextField
        label="Dial Color / Variant"
        value={value.dial}
        onChange={(v) => set('dial', v)}
        placeholder="e.g. Black, Tiffany Blue, Meteorite"
      />
      <SelectField
        label="Movement"
        value={value.movement || null}
        options={WATCH_MOVEMENTS}
        placeholder="Select movement"
        onChange={(v) => set('movement', v)}
      />
      <DetailsTextField
        label="Caliber (optional)"
        value={value.caliber}
        onChange={(v) => set('caliber', v)}
        placeholder="e.g. 3235"
        autoCapitalize="characters"
        autoCorrect={false}
      />
      <OptionWithOtherField
        label="Bracelet / Strap"
        options={WATCH_BRACELETS}
        value={value.bracelet}
        onChange={(v) => set('bracelet', v)}
        customPlaceholder="Specify bracelet or strap"
      />

      {/* Condition and completeness — the biggest effect on value. */}
      <DetailsSectionHeader title="Condition & Completeness" />
      <SelectField
        label="Condition"
        value={value.condition || null}
        options={WATCH_CONDITIONS}
        placeholder="Select condition"
        onChange={(v) => set('condition', v)}
      />
      <SelectField
        label="Case Polish"
        value={value.polish || null}
        options={WATCH_POLISH_OPTIONS}
        placeholder="Select polish status"
        onChange={(v) => set('polish', v)}
      />
      <SelectField
        label="Box & Papers"
        value={value.boxAndPapers || null}
        options={WATCH_BOX_AND_PAPERS}
        placeholder="Select box & papers"
        onChange={(v) => set('boxAndPapers', v)}
      />
      <DetailsTextField
        label="Warranty Card Date"
        value={value.warrantyCardDate}
        onChange={(v) => set('warrantyCardDate', v)}
        placeholder="e.g. 03/2021"
        hint="Modern Rolex and Omega cards show the purchase date."
      />
      <MultiSelectField
        label="Aftermarket Parts"
        values={value.aftermarketParts}
        options={WATCH_AFTERMARKET_PARTS}
        placeholder="None — all original"
        onChange={(v) => set('aftermarketParts', v)}
      />
      <DetailsTipCard
        title="Completeness matters"
        body="Box & papers alone can swing value 10–20% or more, and aftermarket dials, bezels or bracelets lower it a lot. Many collectors look for unpolished cases."
      />

      <DetailsSectionHeader title="Service History" />
      <DetailsTextField
        label="Last Service Date"
        value={value.lastServiceDate}
        onChange={(v) => set('lastServiceDate', v)}
        placeholder="e.g. 06/2023"
      />
      <DetailsTextField
        label="Serviced By"
        value={value.servicedBy}
        onChange={(v) => set('servicedBy', v)}
        placeholder="e.g. Rolex Service Center"
      />
      <DetailsToggleRow
        label="Original Parts Kept"
        sublabel="Original parts were returned or kept at the last service"
        value={value.originalPartsKeptAtService}
        onChange={(v) => set('originalPartsKeptAtService', v)}
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
