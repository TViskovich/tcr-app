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

// Pins details (Add Item → Collectible Type "Other" → Category "Pins").
// Saved via create_other_item/update_other_item — lib/other-item-pins.ts
// maps this form state (also used by Item Detail's edit mode). Edition-specific
// fields (LE size, completer, chaser, mystery set) appear only when relevant.

// Tokyo pins are made by a different company and are their own niche, so
// Tokyo Disney Resort stays a separate option.
export const PIN_ORIGINS = [
  'Disneyland Resort',
  'Walt Disney World',
  'Disneyland Paris',
  'Tokyo Disney Resort',
  'Hong Kong Disneyland',
  'Shanghai Disney Resort',
  'Disney Store / shopDisney',
  'Disney Cruise Line',
  'D23',
  'DVC',
  'WDI (Imagineering)',
  'Other',
];
export const PIN_EDITIONS = [
  'Open Edition (OE)',
  'Limited Edition (LE)',
  'Limited Release (LR)',
  'Limited Edition, Size Not Stated',
  'Artist Proof (AP) / Pre-production (PP)',
  'Cast Exclusive',
];
export const PIN_TRADING_SERIES = ['None', 'Hidden Mickey', 'Cast Lanyard', 'Hidden Disney'];
export const PIN_TYPES = [
  'Standard',
  'Slider',
  'Spinner',
  'Dangle',
  'Hinged',
  'Pin-on-Pin',
  '3D',
  'Light-up',
  'Glitter',
  'Jumbo',
  'Frame',
];
export const PIN_BACKING = ['On Original Card', 'Off Card'];
export const PIN_CERTIFICATE = ['Present', 'Missing', 'Not Applicable'];
export const PIN_CONDITIONS = ['New', 'Excellent', 'Minor Flaws'];
export const PIN_FLAWS = ['Enamel Dips', 'Scratches', 'Bent Post'];
export const PIN_BACKSTAMP = ['Authentic Backstamp Checked', 'Not Checked', 'Suspected Scrapper'];
export const PIN_SOURCES = ['Park', 'shopDisney', 'Trade', 'Reseller', 'Bulk Lot', 'Other'];
export const PIN_TRADE_STATUS = [
  'Not for Trade',
  'Trader (Open to Trade)',
  'ISO (In Search Of)',
  'Keeper / PIC (Pin in Collection)',
];

export type PinFormState = {
  pinId: string;
  name: string;
  characters: string;
  franchise: string;
  year: string;
  origin: string;
  edition: string;
  editionSize: string;
  tradingSeries: string;
  completer: boolean;
  chaser: boolean;
  mysteryBox: boolean;
  mysterySetName: string;
  mysteryNumber: string;
  event: string;
  setName: string;
  setNumber: string;
  setTotal: string;
  pinTypes: string[];
  size: string;
  backing: string;
  certificate: string;
  condition: string;
  flaws: string[];
  backstamp: string;
  source: string;
  tradeStatus: string;
  purchasePrice: string;
  estimatedValue: string;
  notes: string;
};

export const INITIAL_PIN_FORM: PinFormState = {
  pinId: '',
  name: '',
  characters: '',
  franchise: '',
  year: '',
  origin: '',
  edition: '',
  editionSize: '',
  tradingSeries: '',
  completer: false,
  chaser: false,
  mysteryBox: false,
  mysterySetName: '',
  mysteryNumber: '',
  event: '',
  setName: '',
  setNumber: '',
  setTotal: '',
  pinTypes: [],
  size: '',
  backing: '',
  certificate: '',
  condition: '',
  flaws: [],
  backstamp: '',
  source: '',
  tradeStatus: '',
  purchasePrice: '',
  estimatedValue: '',
  notes: '',
};

export function PinDetailsForm({
  value,
  onChange,
}: {
  value: PinFormState;
  onChange: (next: PinFormState) => void;
}) {
  function set<K extends keyof PinFormState>(key: K, next: PinFormState[K]) {
    onChange({ ...value, [key]: next });
  }

  const isLimitedEdition = value.edition === 'Limited Edition (LE)';
  const inTradingSeries = !!value.tradingSeries && value.tradingSeries !== 'None';
  const isHiddenMickey = value.tradingSeries === 'Hidden Mickey';
  const showChaser = inTradingSeries || value.mysteryBox;

  return (
    <>
      <DetailsSectionHeader title="Pin Identity" />
      <DetailsTextField
        label="Pin ID (PinPics)"
        value={value.pinId}
        onChange={(v) => set('pinId', v)}
        keyboardType="number-pad"
        hint="The fastest way to match a pin — traders search by this number."
      />
      <DetailsTextField label="Pin Name" value={value.name} onChange={(v) => set('name', v)} />
      <DetailsTextField
        label="Character(s)"
        value={value.characters}
        onChange={(v) => set('characters', v)}
        placeholder="e.g. Stitch, Mickey & Minnie"
      />
      <DetailsTextField
        label="Franchise / Film"
        value={value.franchise}
        onChange={(v) => set('franchise', v)}
        placeholder="e.g. Haunted Mansion, Star Wars, Lilo & Stitch"
      />
      <DetailsTextField
        label="Year Released"
        value={value.year}
        onChange={(v) => set('year', v)}
        keyboardType="number-pad"
        maxLength={4}
      />
      <OptionWithOtherField
        label="Origin"
        options={PIN_ORIGINS}
        value={value.origin}
        onChange={(v) => set('origin', v)}
        customPlaceholder="Specify origin"
      />

      {/* Edition — the biggest value driver. */}
      <DetailsSectionHeader title="Edition" />
      <SelectField
        label="Edition Type"
        value={value.edition || null}
        options={PIN_EDITIONS}
        placeholder="Select edition type"
        onChange={(v) => onChange({ ...value, edition: v, editionSize: v === 'Limited Edition (LE)' ? value.editionSize : '' })}
        scrollable
      />
      {isLimitedEdition && (
        <DetailsTextField
          label="Edition Size"
          value={value.editionSize}
          onChange={(v) => set('editionSize', v)}
          keyboardType="number-pad"
          placeholder="e.g. 750"
          hint={value.editionSize.trim() ? `Displays as LE ${value.editionSize.trim()}` : 'e.g. 750 displays as LE 750'}
        />
      )}
      <SelectField
        label="Trading-Only Series"
        value={value.tradingSeries || null}
        options={PIN_TRADING_SERIES}
        placeholder="Select series"
        onChange={(v) =>
          onChange({
            ...value,
            tradingSeries: v,
            completer: v === 'Hidden Mickey' ? value.completer : false,
            chaser: v !== 'None' || value.mysteryBox ? value.chaser : false,
          })
        }
      />
      {isHiddenMickey && (
        <DetailsToggleRow
          label="Completer"
          sublabel="The pin that completes a Hidden Mickey set"
          value={value.completer}
          onChange={(v) => set('completer', v)}
        />
      )}
      <DetailsToggleRow
        label="Mystery / Blind Box"
        sublabel="From a mystery or blind box set"
        value={value.mysteryBox}
        onChange={(v) =>
          onChange({
            ...value,
            mysteryBox: v,
            mysterySetName: v ? value.mysterySetName : '',
            mysteryNumber: v ? value.mysteryNumber : '',
            chaser: v || inTradingSeries ? value.chaser : false,
          })
        }
      />
      {value.mysteryBox && (
        <>
          <DetailsTextField
            label="Mystery Set Name"
            value={value.mysterySetName}
            onChange={(v) => set('mysterySetName', v)}
          />
          <DetailsTextField
            label="Number in Set"
            value={value.mysteryNumber}
            onChange={(v) => set('mysteryNumber', v)}
            keyboardType="number-pad"
          />
        </>
      )}
      {showChaser && (
        <DetailsToggleRow
          label="Chaser"
          sublabel="The rarer variant in the series"
          value={value.chaser}
          onChange={(v) => set('chaser', v)}
        />
      )}
      <DetailsTextField
        label="Event"
        value={value.event}
        onChange={(v) => set('event', v)}
        placeholder="e.g. pin trading night, anniversary, special event"
      />
      <DetailsTextField label="Series / Set Name" value={value.setName} onChange={(v) => set('setName', v)} />
      <DetailsPairField
        label="Number in Series"
        first={value.setNumber}
        second={value.setTotal}
        onChangeFirst={(v) => set('setNumber', v)}
        onChangeSecond={(v) => set('setTotal', v)}
        firstPlaceholder="No."
        secondPlaceholder="Total"
        separator="of"
        hint={
          value.setNumber.trim() && value.setTotal.trim()
            ? `Displays as ${value.setNumber.trim()} of ${value.setTotal.trim()}`
            : 'e.g. 2 of 5'
        }
      />

      <DetailsSectionHeader title="Physical" />
      <MultiSelectField
        label="Pin Type"
        values={value.pinTypes}
        options={PIN_TYPES}
        placeholder="Select pin type"
        onChange={(v) => set('pinTypes', v)}
      />
      <DetailsTextField
        label="Size"
        value={value.size}
        onChange={(v) => set('size', v)}
        placeholder="e.g. 1.5 in"
        hint="Mainly to flag jumbos."
      />
      <SelectField
        label="Backing Card"
        value={value.backing || null}
        options={PIN_BACKING}
        placeholder="Select backing card"
        onChange={(v) => set('backing', v)}
      />
      <SelectField
        label="LE Certificate / Box"
        value={value.certificate || null}
        options={PIN_CERTIFICATE}
        placeholder="Select certificate / box"
        onChange={(v) => set('certificate', v)}
      />

      <DetailsSectionHeader title="Condition & Authenticity" />
      <SelectField
        label="Condition"
        value={value.condition || null}
        options={PIN_CONDITIONS}
        placeholder="Select condition"
        onChange={(v) => onChange({ ...value, condition: v, flaws: v === 'Minor Flaws' ? value.flaws : [] })}
      />
      {value.condition === 'Minor Flaws' && (
        <MultiSelectField
          label="Flaws"
          values={value.flaws}
          options={PIN_FLAWS}
          placeholder="Select flaws"
          onChange={(v) => set('flaws', v)}
        />
      )}
      <SelectField
        label="Backstamp Check"
        value={value.backstamp || null}
        options={PIN_BACKSTAMP}
        placeholder="Select backstamp check"
        onChange={(v) => set('backstamp', v)}
      />
      <DetailsTipCard
        title="Photograph the back"
        body="Authentic Disney pins have an official Pin Trading logo, copyright and a Mickey-head waffle pattern on the back. Scrappers (unauthorized factory pins) often have sloppy backs — add a photo of the back."
      />
      <OptionWithOtherField
        label="Purchase Source"
        options={PIN_SOURCES}
        value={value.source}
        onChange={(v) => set('source', v)}
        customPlaceholder="Specify source"
      />
      {value.source === 'Bulk Lot' && (
        <DetailsTipCard
          title="Bulk lots"
          body="Pins bought in bulk lots online are where most scrappers come from — check the backstamp carefully."
        />
      )}

      <DetailsSectionHeader title="Trading" />
      <SelectField
        label="Trade Status"
        value={value.tradeStatus || null}
        options={PIN_TRADE_STATUS}
        placeholder="Select trade status"
        onChange={(v) => set('tradeStatus', v)}
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
