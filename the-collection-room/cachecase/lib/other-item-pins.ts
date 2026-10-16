import { INITIAL_PIN_FORM, type PinFormState } from '@/components/item-detail/pin-details-form';
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
import type { OtherItemDetails } from '@/types';

// Other → Pins (components/item-detail/pin-details-form.tsx). Shared
// columns: Pin Name → title (required), Year Released → year, Estimated
// Value, Notes → description; Pin ID → search_identifier; Purchase Price →
// private. No brand. The rest → details ('pins' spec in supabase/
// migrations/20261024120000_add_other_item_details.sql).
//
// Only the fields the form is showing are saved, with the form's own rules:
// edition size for LE, completer for Hidden Mickey, chaser for a trading
// series or a mystery box, mystery set fields for a mystery box, and flaws
// for Minor Flaws.

function sections(form: PinFormState) {
  const inTradingSeries = !!form.tradingSeries && form.tradingSeries !== 'None';
  return {
    isLimitedEdition: form.edition === 'Limited Edition (LE)',
    isHiddenMickey: form.tradingSeries === 'Hidden Mickey',
    showChaser: inTradingSeries || form.mysteryBox,
    showFlaws: form.condition === 'Minor Flaws',
  };
}

export const pinAdapter: OtherCategoryAdapter<PinFormState> = {
  category: 'pins',
  initialForm: INITIAL_PIN_FORM,

  validate(form) {
    const s = sections(form);
    return firstIssue(
      requiredText(form.name, 'Pin Name', 'Please enter the pin name.'),
      unspecifiedOption(form.origin, 'Origin'),
      unspecifiedOption(form.source, 'Purchase Source'),
      textTooLong(form.pinId, SEARCH_IDENTIFIER_MAX, 'Pin ID'),
      textTooLong(form.characters, 200, 'Character(s)'),
      textTooLong(form.franchise, 120, 'Franchise / Film'),
      form.mysteryBox ? textTooLong(form.mysterySetName, 120, 'Mystery Set Name') : null,
      textTooLong(form.event, 120, 'Event'),
      textTooLong(form.setName, 120, 'Series / Set Name'),
      textTooLong(form.size, 20, 'Size'),
      parseOptionalYear(form.year, 'Year Released').issue,
      s.isLimitedEdition ? parseOptionalInteger(form.editionSize, 'Edition Size').issue : null,
      form.mysteryBox ? parseOptionalInteger(form.mysteryNumber, 'Number in Set').issue : null,
      parseOptionalInteger(form.setNumber, 'Number in Series').issue,
      parseOptionalInteger(form.setTotal, 'Series Total').issue,
      parseOptionalMoney(form.purchasePrice, 'Purchase Price').issue,
      parseOptionalMoney(form.estimatedValue, 'Estimated Value').issue,
    );
  },

  toFields(form) {
    const s = sections(form);
    return {
      title: form.name.trim(),
      brand: null,
      year: parseOptionalYear(form.year, 'Year Released').value,
      estimatedValue: parseOptionalMoney(form.estimatedValue, 'Estimated Value').value,
      description: textOrNull(form.notes),
      searchIdentifier: textOrNull(form.pinId),
      purchasePrice: parseOptionalMoney(form.purchasePrice, 'Purchase Price').value,
      details: compactDetails({
        characters: form.characters,
        franchise: form.franchise,
        origin: form.origin,
        edition: form.edition,
        edition_size: s.isLimitedEdition ? parseOptionalInteger(form.editionSize, '').value : null,
        trading_series: form.tradingSeries,
        completer: s.isHiddenMickey ? form.completer : null,
        chaser: s.showChaser ? form.chaser : null,
        mystery_box: form.mysteryBox,
        mystery_set_name: form.mysteryBox ? form.mysterySetName : null,
        mystery_number: form.mysteryBox ? parseOptionalInteger(form.mysteryNumber, '').value : null,
        event: form.event,
        set_name: form.setName,
        set_number: parseOptionalInteger(form.setNumber, '').value,
        set_total: parseOptionalInteger(form.setTotal, '').value,
        pin_types: form.pinTypes,
        size: form.size,
        backing: form.backing,
        certificate: form.certificate,
        condition: form.condition,
        flaws: s.showFlaws ? form.flaws : null,
        backstamp: form.backstamp,
        source: form.source,
        trade_status: form.tradeStatus,
      }),
    };
  },

  fromItem(item, details, privateDetails) {
    return {
      pinId: details?.search_identifier ?? '',
      name: item.title ?? '',
      characters: detailText(details, 'characters'),
      franchise: detailText(details, 'franchise'),
      year: yearText(item.year),
      origin: detailText(details, 'origin'),
      edition: detailText(details, 'edition'),
      editionSize: detailText(details, 'edition_size'),
      tradingSeries: detailText(details, 'trading_series'),
      completer: detailBool(details, 'completer'),
      chaser: detailBool(details, 'chaser'),
      mysteryBox: detailBool(details, 'mystery_box'),
      mysterySetName: detailText(details, 'mystery_set_name'),
      mysteryNumber: detailText(details, 'mystery_number'),
      event: detailText(details, 'event'),
      setName: detailText(details, 'set_name'),
      setNumber: detailText(details, 'set_number'),
      setTotal: detailText(details, 'set_total'),
      pinTypes: detailList(details, 'pin_types'),
      size: detailText(details, 'size'),
      backing: detailText(details, 'backing'),
      certificate: detailText(details, 'certificate'),
      condition: detailText(details, 'condition'),
      flaws: detailList(details, 'flaws'),
      backstamp: detailText(details, 'backstamp'),
      source: detailText(details, 'source'),
      tradeStatus: detailText(details, 'trade_status'),
      purchasePrice: moneyText(privateDetails?.purchase_price),
      estimatedValue: moneyText(item.estimated_value),
      notes: item.description ?? '',
    };
  },

  // Name, then franchise / characters, then edition (LE size), then origin
  // · year.
  identity(item, details) {
    const about =
      [detailText(details, 'franchise'), detailText(details, 'characters')].filter(Boolean).join(' · ') || null;
    const originYear =
      [detailText(details, 'origin'), item.year != null ? String(item.year) : null].filter(Boolean).join(' · ') || null;
    return { title: item.title?.trim() || 'Untitled Item', subtitleLines: [about, editionLabel(details), originYear] };
  },

  metadataRows(item, details, privateDetails) {
    return [
      { label: 'Pin ID', value: details?.search_identifier ? `#${details.search_identifier}` : null },
      { label: 'Pin Name', value: item.title },
      { label: 'Character(s)', value: detailText(details, 'characters') },
      { label: 'Franchise / Film', value: detailText(details, 'franchise') },
      { label: 'Edition', value: editionLabel(details) },
      { label: 'Year Released', value: yearText(item.year) },
      { label: 'Origin', value: detailText(details, 'origin') },
      { label: 'Trading-Only Series', value: detailText(details, 'trading_series') },
      { label: 'Completer', value: yesOrNull(detailBool(details, 'completer')) },
      { label: 'Chaser', value: yesOrNull(detailBool(details, 'chaser')) },
      { label: 'Mystery / Blind Box', value: yesOrNull(detailBool(details, 'mystery_box')) },
      { label: 'Mystery Set', value: mysteryLabel(details) },
      { label: 'Event', value: detailText(details, 'event') },
      { label: 'Series / Set', value: detailText(details, 'set_name') },
      {
        label: 'Number in Series',
        value: pairLabel(detailText(details, 'set_number'), detailText(details, 'set_total'), ' of '),
      },
      { label: 'Pin Type', value: detailList(details, 'pin_types').join(', ') },
      { label: 'Size', value: detailText(details, 'size') },
      { label: 'Backing Card', value: detailText(details, 'backing') },
      { label: 'LE Certificate / Box', value: detailText(details, 'certificate') },
      { label: 'Condition', value: detailText(details, 'condition') },
      { label: 'Flaws', value: detailList(details, 'flaws').join(', ') },
      { label: 'Backstamp Check', value: detailText(details, 'backstamp') },
      { label: 'Purchase Source', value: detailText(details, 'source') },
      { label: 'Trade Status', value: detailText(details, 'trade_status') },
      ...valueRows(item, privateDetails),
    ];
  },
};

// "Limited Edition (LE) · LE 750" style: the edition type, plus the LE size.
function editionLabel(details: OtherItemDetails | null): string | null {
  const edition = detailText(details, 'edition');
  const size = detailText(details, 'edition_size');
  return [edition, size ? `LE ${size}` : null].filter(Boolean).join(' · ') || null;
}

function mysteryLabel(details: OtherItemDetails | null): string | null {
  const name = detailText(details, 'mystery_set_name');
  const number = detailText(details, 'mystery_number');
  return [name, number ? `#${number}` : null].filter(Boolean).join(' ') || null;
}
