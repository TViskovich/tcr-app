import { INITIAL_WATCH_FORM, type WatchFormState } from '@/components/item-detail/watch-details-form';
import {
  compactDetails,
  detailBool,
  detailList,
  detailText,
  firstIssue,
  moneyText,
  parseOptionalDecimal,
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

// Other → Watches (components/item-detail/watch-details-form.tsx). Shared
// columns: Model / Line → title (required), Brand → brand, Year → year,
// Estimated Value, Notes → description; Reference Number →
// search_identifier; Purchase Price → private. The rest → details ('watches'
// spec in supabase/migrations/20261024120000_add_other_item_details.sql).

const CASE_SIZE_MIN = 1;
const CASE_SIZE_MAX = 100;

export const watchAdapter: OtherCategoryAdapter<WatchFormState> = {
  category: 'watches',
  initialForm: INITIAL_WATCH_FORM,

  validate(form) {
    return firstIssue(
      requiredText(form.model, 'Model', 'Please enter the watch model or line.'),
      unspecifiedOption(form.brand, 'Brand'),
      unspecifiedOption(form.caseMaterial, 'Case Material'),
      unspecifiedOption(form.bracelet, 'Bracelet / Strap'),
      textTooLong(form.referenceNumber, SEARCH_IDENTIFIER_MAX, 'Reference Number'),
      textTooLong(form.nickname, 120, 'Nickname'),
      textTooLong(form.dial, 120, 'Dial Color / Variant'),
      textTooLong(form.caliber, 60, 'Caliber'),
      textTooLong(form.warrantyCardDate, 20, 'Warranty Card Date'),
      textTooLong(form.lastServiceDate, 20, 'Last Service Date'),
      textTooLong(form.servicedBy, 120, 'Serviced By'),
      parseOptionalYear(form.year, 'Year').issue,
      parseOptionalDecimal(form.caseSize, 'Case Size', CASE_SIZE_MIN, CASE_SIZE_MAX).issue,
      parseOptionalMoney(form.purchasePrice, 'Purchase Price').issue,
      parseOptionalMoney(form.estimatedValue, 'Estimated Value').issue,
    );
  },

  toFields(form) {
    return {
      title: form.model.trim(),
      brand: textOrNull(form.brand),
      year: parseOptionalYear(form.year, 'Year').value,
      estimatedValue: parseOptionalMoney(form.estimatedValue, 'Estimated Value').value,
      description: textOrNull(form.notes),
      searchIdentifier: textOrNull(form.referenceNumber),
      purchasePrice: parseOptionalMoney(form.purchasePrice, 'Purchase Price').value,
      details: compactDetails({
        nickname: form.nickname,
        case_size_mm: parseOptionalDecimal(form.caseSize, 'Case Size', CASE_SIZE_MIN, CASE_SIZE_MAX).value,
        case_material: form.caseMaterial,
        dial: form.dial,
        movement: form.movement,
        caliber: form.caliber,
        bracelet: form.bracelet,
        condition: form.condition,
        polish: form.polish,
        box_and_papers: form.boxAndPapers,
        warranty_card_date: form.warrantyCardDate,
        aftermarket_parts: form.aftermarketParts,
        last_service_date: form.lastServiceDate,
        serviced_by: form.servicedBy,
        original_parts_kept: form.originalPartsKeptAtService,
      }),
    };
  },

  fromItem(item, details, privateDetails) {
    return {
      brand: item.brand ?? '',
      model: item.title ?? '',
      referenceNumber: details?.search_identifier ?? '',
      year: yearText(item.year),
      nickname: detailText(details, 'nickname'),
      caseSize: detailText(details, 'case_size_mm'),
      caseMaterial: detailText(details, 'case_material'),
      dial: detailText(details, 'dial'),
      movement: detailText(details, 'movement'),
      caliber: detailText(details, 'caliber'),
      bracelet: detailText(details, 'bracelet'),
      condition: detailText(details, 'condition'),
      polish: detailText(details, 'polish'),
      boxAndPapers: detailText(details, 'box_and_papers'),
      warrantyCardDate: detailText(details, 'warranty_card_date'),
      lastServiceDate: detailText(details, 'last_service_date'),
      servicedBy: detailText(details, 'serviced_by'),
      originalPartsKeptAtService: detailBool(details, 'original_parts_kept'),
      aftermarketParts: detailList(details, 'aftermarket_parts'),
      purchasePrice: moneyText(privateDetails?.purchase_price),
      estimatedValue: moneyText(item.estimated_value),
      notes: item.description ?? '',
    };
  },

  // Brand + model is how watches are named; the nickname and reference
  // follow.
  identity(item, details) {
    const title = [item.brand, item.title?.trim()].filter(Boolean).join(' ') || 'Untitled Item';
    const refYear =
      [details?.search_identifier ? `Ref. ${details.search_identifier}` : null, item.year != null ? String(item.year) : null]
        .filter(Boolean)
        .join(' · ') || null;
    return { title, subtitleLines: [detailText(details, 'nickname') || null, refYear] };
  },

  metadataRows(item, details, privateDetails) {
    const caseSize = detailText(details, 'case_size_mm');
    const aftermarket = detailList(details, 'aftermarket_parts');
    return [
      { label: 'Brand', value: item.brand },
      { label: 'Model / Line', value: item.title },
      { label: 'Reference Number', value: details?.search_identifier ?? null },
      { label: 'Year', value: yearText(item.year) },
      { label: 'Nickname', value: detailText(details, 'nickname') },
      { label: 'Case Size', value: caseSize ? `${caseSize} mm` : null },
      { label: 'Case Material', value: detailText(details, 'case_material') },
      { label: 'Dial', value: detailText(details, 'dial') },
      { label: 'Movement', value: detailText(details, 'movement') },
      { label: 'Caliber', value: detailText(details, 'caliber') },
      { label: 'Bracelet / Strap', value: detailText(details, 'bracelet') },
      { label: 'Condition', value: detailText(details, 'condition') },
      { label: 'Case Polish', value: detailText(details, 'polish') },
      { label: 'Box & Papers', value: detailText(details, 'box_and_papers') },
      { label: 'Warranty Card Date', value: detailText(details, 'warranty_card_date') },
      { label: 'Aftermarket Parts', value: aftermarket.join(', ') },
      { label: 'Last Service Date', value: detailText(details, 'last_service_date') },
      { label: 'Serviced By', value: detailText(details, 'serviced_by') },
      { label: 'Original Parts Kept', value: yesOrNull(detailBool(details, 'original_parts_kept')) },
      ...valueRows(item, privateDetails),
    ];
  },
};
