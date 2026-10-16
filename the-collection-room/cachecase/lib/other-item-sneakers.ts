import { INITIAL_SNEAKER_FORM, type SneakerFormState } from '@/components/item-detail/sneaker-details-form';
import {
  compactDetails,
  detailBool,
  detailList,
  detailText,
  firstIssue,
  moneyText,
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

// Other → Sneakers (components/item-detail/sneaker-details-form.tsx) ↔
// create_other_item/update_other_item. Shared columns: Model → title (the
// one required field), Brand → brand, Release Year → year, Estimated Value
// → estimated_value, Notes → description; Style Code / SKU →
// search_identifier; Purchase Price → the owner-only private row.
// Everything else goes in details under the keys of the 'sneakers' spec in
// supabase/migrations/20261024120000_add_other_item_details.sql.

export const sneakerAdapter: OtherCategoryAdapter<SneakerFormState> = {
  category: 'sneakers',
  initialForm: INITIAL_SNEAKER_FORM,

  validate(form) {
    return firstIssue(
      requiredText(form.model, 'Model', 'Please enter the sneaker model.'),
      unspecifiedOption(form.brand, 'Brand'),
      unspecifiedOption(form.authenticatedBy, 'Authentication service'),
      textTooLong(form.styleCode, SEARCH_IDENTIFIER_MAX, 'Style Code / SKU'),
      textTooLong(form.colorway, 120, 'Colorway / Nickname'),
      textTooLong(form.size, 12, 'Size'),
      textTooLong(form.authTagOrReceipt, 120, 'Tag / Receipt Number'),
      textTooLong(form.collabPartner, 120, 'Collab Partner'),
      parseOptionalYear(form.releaseYear, 'Release Year').issue,
      parseOptionalMoney(form.purchasePrice, 'Purchase Price').issue,
      parseOptionalMoney(form.estimatedValue, 'Estimated Value').issue,
    );
  },

  toFields(form) {
    const isUsed = form.condition === 'Used';
    const isAuthenticated = !!form.authenticatedBy.trim() && form.authenticatedBy !== 'Not Authenticated';
    return {
      title: form.model.trim(),
      brand: textOrNull(form.brand),
      year: parseOptionalYear(form.releaseYear, 'Release Year').value,
      estimatedValue: parseOptionalMoney(form.estimatedValue, 'Estimated Value').value,
      description: textOrNull(form.notes),
      searchIdentifier: textOrNull(form.styleCode),
      purchasePrice: parseOptionalMoney(form.purchasePrice, 'Purchase Price').value,
      details: compactDetails({
        colorway: form.colorway,
        size: form.size,
        size_system: form.sizeSystem,
        condition: form.condition,
        // Conditional fields go only with their controlling field (the
        // database enforces the same).
        condition_score: isUsed ? form.conditionScore : null,
        box: form.box,
        extras: form.extras,
        authenticated_by: form.authenticatedBy,
        auth_tag_or_receipt: isAuthenticated ? form.authTagOrReceipt : null,
        collab_partner: form.collabPartner,
        limited_release: form.limitedRelease,
      }),
    };
  },

  fromItem(item, details, privateDetails) {
    return {
      brand: item.brand ?? '',
      model: item.title ?? '',
      colorway: detailText(details, 'colorway'),
      styleCode: details?.search_identifier ?? '',
      releaseYear: yearText(item.year),
      size: detailText(details, 'size'),
      sizeSystem: detailText(details, 'size_system'),
      condition: detailText(details, 'condition'),
      conditionScore: detailText(details, 'condition_score'),
      box: detailText(details, 'box'),
      extras: detailList(details, 'extras'),
      authenticatedBy: detailText(details, 'authenticated_by'),
      authTagOrReceipt: detailText(details, 'auth_tag_or_receipt'),
      collabPartner: detailText(details, 'collab_partner'),
      limitedRelease: detailBool(details, 'limited_release'),
      purchasePrice: moneyText(privateDetails?.purchase_price),
      estimatedValue: moneyText(item.estimated_value),
      notes: item.description ?? '',
    };
  },

  // Model is the headline; the colorway is what collectors call them, then
  // brand · year, then the size.
  identity(item, details) {
    const brandYear = [item.brand, item.year != null ? String(item.year) : null].filter(Boolean).join(' · ') || null;
    return {
      title: item.title?.trim() || 'Untitled Item',
      subtitleLines: [detailText(details, 'colorway') || null, brandYear, sizeLabel(details)],
    };
  },

  metadataRows(item, details, privateDetails) {
    const condition = detailText(details, 'condition');
    const score = detailText(details, 'condition_score');
    return [
      { label: 'Brand', value: item.brand },
      { label: 'Model', value: item.title },
      { label: 'Colorway / Nickname', value: detailText(details, 'colorway') },
      { label: 'Style Code / SKU', value: details?.search_identifier ?? null },
      { label: 'Size', value: sizeLabel(details) },
      { label: 'Release Year', value: yearText(item.year) },
      { label: 'Condition', value: condition && score ? `${condition} · ${score}/10` : condition },
      { label: 'Box', value: detailText(details, 'box') },
      { label: 'Extras', value: detailList(details, 'extras').join(', ') },
      { label: 'Authenticated By', value: detailText(details, 'authenticated_by') },
      { label: 'Tag / Receipt Number', value: detailText(details, 'auth_tag_or_receipt') },
      { label: 'Collab Partner', value: detailText(details, 'collab_partner') },
      { label: 'Limited / Regional Release', value: yesOrNull(detailBool(details, 'limited_release')) },
      ...valueRows(item, privateDetails),
    ];
  },
};

function sizeLabel(details: OtherItemDetails | null): string | null {
  const size = detailText(details, 'size');
  if (!size) return null;
  const system = detailText(details, 'size_system');
  return system ? `${system} ${size}` : size;
}
