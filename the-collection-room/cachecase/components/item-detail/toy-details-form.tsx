import { CollapsibleSection } from '@/components/item-detail/collapsible-section';
import {
  DetailsSectionHeader,
  DetailsTextField,
  DetailsTipCard,
  DetailsToggleRow,
} from '@/components/item-detail/details-form-parts';
import { OptionWithOtherField } from '@/components/item-detail/option-with-other-field';
import { MultiSelectField, SelectField } from '@/components/item-detail/select-field';

// Toys details (Add Item → Collectible Type "Other" → Category "Toys",
// and Item Detail's edit mode). Saved via create_other_item/
// update_other_item — lib/other-item-toys.ts maps this form state, saving
// only the sections shown. Toy Type switches on the category-specific sections (die-cast,
// plush, electronic) only when relevant.

export const TOY_TYPES = ['Action Figure', 'Die-cast', 'Plush', 'Electronic', 'Other'];
export const TOY_BRANDS = ['Hasbro', 'Mattel', 'Kenner', 'Bandai', 'Hot Wheels', 'Funko', 'LEGO', 'Other'];
export const TOY_RELEASES = ['Original Release', 'Reissue'];
export const TOY_VARIANTS = ['Paint Variant', 'Card-Back Variant', 'Packaging Variant'];
export const TOY_EXCLUSIVES = [
  'Not Exclusive',
  'Convention (SDCC)',
  'Retailer (Target)',
  'Retailer (Walmart)',
  'Mail-Away',
  'Other',
];
export const TOY_PACKAGING = [
  'MOC (Mint on Card)',
  'MIB (Mint in Box)',
  'NRFB (Never Removed from Box)',
  'Opened, Complete',
  'Loose',
];
export const TOY_PACKAGE_ISSUES = ['Card Creases', 'Bubble Dents', 'Bubble Yellowing', 'Box Wear'];
export const TOY_ACCESSORIES = ['Complete', 'Incomplete', 'Not Applicable'];
export const TOY_CONDITIONS = ['Mint', 'Excellent', 'Good', 'Played With'];
export const TOY_CONDITION_ISSUES = ['Paint Wear', 'Loose Joints', 'Sun Fading', 'Broken Parts'];
export const TOY_GRADERS = ['AFA', 'CAS', 'UKG', 'Other'];
export const DIECAST_SCALES = ['1:64', '1:43', '1:24', '1:18', 'Other'];
export const DIECAST_TREASURE_HUNT = ['None', 'Treasure Hunt', 'Super Treasure Hunt'];
export const PLUSH_HANG_TAG = ['Attached, Mint', 'Attached, Creased / Damaged', 'Missing'];
export const PLUSH_TUSH_TAG = ['Attached, Mint', 'Attached, Cut / Faded', 'Missing'];
export const ELECTRONIC_WORKING = ['Working', 'Partially Working', 'Not Working', 'Untested'];
export const ELECTRONIC_CORROSION = ['None', 'Light', 'Heavy', 'Unknown'];

export type ToyFormState = {
  toyType: string;
  brand: string;
  line: string;
  name: string;
  year: string;
  release: string;
  itemNumber: string;
  wave: string;
  variants: string[];
  variantDetails: string;
  exclusive: string;
  packaging: string;
  packageIssues: string[];
  accessories: string;
  missingPieces: string;
  condition: string;
  conditionIssues: string[];
  graded: boolean;
  gradingCompany: string;
  grade: string;
  diecastScale: string;
  treasureHunt: string;
  castingName: string;
  hangTag: string;
  tushTag: string;
  working: string;
  batteryCorrosion: string;
  purchasePrice: string;
  estimatedValue: string;
  notes: string;
};

export const INITIAL_TOY_FORM: ToyFormState = {
  toyType: '',
  brand: '',
  line: '',
  name: '',
  year: '',
  release: '',
  itemNumber: '',
  wave: '',
  variants: [],
  variantDetails: '',
  exclusive: '',
  packaging: '',
  packageIssues: [],
  accessories: '',
  missingPieces: '',
  condition: '',
  conditionIssues: [],
  graded: false,
  gradingCompany: '',
  grade: '',
  diecastScale: '',
  treasureHunt: '',
  castingName: '',
  hangTag: '',
  tushTag: '',
  working: '',
  batteryCorrosion: '',
  purchasePrice: '',
  estimatedValue: '',
  notes: '',
};

export function ToyDetailsForm({
  value,
  onChange,
}: {
  value: ToyFormState;
  onChange: (next: ToyFormState) => void;
}) {
  function set<K extends keyof ToyFormState>(key: K, next: ToyFormState[K]) {
    onChange({ ...value, [key]: next });
  }

  const isActionFigure = value.toyType === 'Action Figure';
  const isDiecast = value.toyType === 'Die-cast';
  const isPlush = value.toyType === 'Plush';
  const isElectronic = value.toyType === 'Electronic';
  const isLoose = value.packaging === 'Loose';

  return (
    <>
      <DetailsSectionHeader title="Toy Identity" />
      <SelectField
        label="Toy Type"
        value={value.toyType || null}
        options={TOY_TYPES}
        placeholder="Select toy type"
        onChange={(v) => set('toyType', v)}
      />
      <OptionWithOtherField
        label="Brand / Manufacturer"
        options={TOY_BRANDS}
        value={value.brand}
        onChange={(v) => set('brand', v)}
        customPlaceholder="Specify brand"
      />
      <DetailsTextField
        label="Line / Series"
        value={value.line}
        onChange={(v) => set('line', v)}
        placeholder="e.g. Star Wars Black Series, Transformers G1"
      />
      <DetailsTextField
        label="Character / Item Name"
        value={value.name}
        onChange={(v) => set('name', v)}
      />
      <DetailsTextField
        label="Year"
        value={value.year}
        onChange={(v) => set('year', v)}
        keyboardType="number-pad"
        maxLength={4}
      />
      <SelectField
        label="Release"
        value={value.release || null}
        options={TOY_RELEASES}
        placeholder="Original or reissue?"
        onChange={(v) => set('release', v)}
      />
      <DetailsTextField
        label="Item / Model Number"
        value={value.itemNumber}
        onChange={(v) => set('itemNumber', v)}
        autoCapitalize="characters"
        autoCorrect={false}
      />
      {(isActionFigure || !value.toyType) && (
        <DetailsTextField
          label="Wave / Assortment"
          value={value.wave}
          onChange={(v) => set('wave', v)}
          hint="Matters for action figure lines."
        />
      )}
      <MultiSelectField
        label="Variant"
        values={value.variants}
        options={TOY_VARIANTS}
        placeholder="None — standard release"
        onChange={(v) => set('variants', v)}
      />
      {value.variants.length > 0 && (
        <DetailsTextField
          label="Variant Details"
          value={value.variantDetails}
          onChange={(v) => set('variantDetails', v)}
          placeholder="Describe the variant"
        />
      )}
      <OptionWithOtherField
        label="Exclusive"
        options={TOY_EXCLUSIVES}
        value={value.exclusive}
        onChange={(v) => set('exclusive', v)}
        customPlaceholder="Specify exclusive"
      />
      <DetailsTipCard
        title="Reissues and variants"
        body="Reissues are worth far less than original releases, and paint, card-back or packaging variants can have very different values."
      />

      {/* Packaging — the biggest value driver. */}
      <DetailsSectionHeader title="Packaging" />
      <SelectField
        label="Packaging Status"
        value={value.packaging || null}
        options={TOY_PACKAGING}
        placeholder="Select packaging status"
        onChange={(v) => onChange({ ...value, packaging: v, packageIssues: v === 'Loose' ? [] : value.packageIssues })}
      />
      {!isLoose && (
        <MultiSelectField
          label="Package Condition"
          values={value.packageIssues}
          options={TOY_PACKAGE_ISSUES}
          placeholder="No issues"
          onChange={(v) => set('packageIssues', v)}
        />
      )}

      <DetailsSectionHeader title="Completeness & Condition" />
      <SelectField
        label="Accessories"
        value={value.accessories || null}
        options={TOY_ACCESSORIES}
        placeholder="Select accessories"
        onChange={(v) => onChange({ ...value, accessories: v, missingPieces: v === 'Incomplete' ? value.missingPieces : '' })}
      />
      {value.accessories === 'Incomplete' && (
        <DetailsTextField
          label="Missing Pieces"
          value={value.missingPieces}
          onChange={(v) => set('missingPieces', v)}
          placeholder="List the missing pieces"
        />
      )}
      <SelectField
        label="Condition"
        value={value.condition || null}
        options={TOY_CONDITIONS}
        placeholder="Select condition"
        onChange={(v) => set('condition', v)}
      />
      <MultiSelectField
        label="Condition Notes"
        values={value.conditionIssues}
        options={TOY_CONDITION_ISSUES}
        placeholder="No issues"
        onChange={(v) => set('conditionIssues', v)}
      />
      <DetailsToggleRow
        label="Graded"
        sublabel="Professionally graded and encased (AFA, CAS, UKG)"
        value={value.graded}
        onChange={(v) =>
          onChange({ ...value, graded: v, gradingCompany: v ? value.gradingCompany : '', grade: v ? value.grade : '' })
        }
      />
      {value.graded && (
        <>
          <OptionWithOtherField
            label="Grading Company"
            options={TOY_GRADERS}
            value={value.gradingCompany}
            onChange={(v) => set('gradingCompany', v)}
            customPlaceholder="Specify grading company"
          />
          <DetailsTextField
            label="Grade"
            value={value.grade}
            onChange={(v) => set('grade', v)}
            placeholder="e.g. 85, 9.0"
            autoCapitalize="characters"
          />
        </>
      )}

      {/* Category-specific sections — only for the matching toy type. */}
      {isDiecast && (
        <>
          <DetailsSectionHeader title="Die-cast" />
          <OptionWithOtherField
            label="Scale"
            options={DIECAST_SCALES}
            value={value.diecastScale}
            onChange={(v) => set('diecastScale', v)}
            customPlaceholder="Specify scale"
          />
          <SelectField
            label="Treasure Hunt"
            value={value.treasureHunt || null}
            options={DIECAST_TREASURE_HUNT}
            placeholder="Select"
            onChange={(v) => set('treasureHunt', v)}
          />
          <DetailsTextField
            label="Casting Name"
            value={value.castingName}
            onChange={(v) => set('castingName', v)}
            placeholder="e.g. Bone Shaker, Twin Mill"
          />
        </>
      )}
      {isPlush && (
        <>
          <DetailsSectionHeader title="Plush Tags" />
          <SelectField
            label="Hang Tag"
            value={value.hangTag || null}
            options={PLUSH_HANG_TAG}
            placeholder="Select hang tag condition"
            onChange={(v) => set('hangTag', v)}
          />
          <SelectField
            label="Tush Tag"
            value={value.tushTag || null}
            options={PLUSH_TUSH_TAG}
            placeholder="Select tush tag condition"
            onChange={(v) => set('tushTag', v)}
          />
          <DetailsTipCard title="Tags matter" body="Tag condition matters a lot for plush like Beanie Babies." />
        </>
      )}
      {isElectronic && (
        <>
          <DetailsSectionHeader title="Electronics" />
          <SelectField
            label="Working Condition"
            value={value.working || null}
            options={ELECTRONIC_WORKING}
            placeholder="Select working condition"
            onChange={(v) => set('working', v)}
          />
          <SelectField
            label="Battery Corrosion"
            value={value.batteryCorrosion || null}
            options={ELECTRONIC_CORROSION}
            placeholder="Select corrosion"
            onChange={(v) => set('batteryCorrosion', v)}
          />
        </>
      )}

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
