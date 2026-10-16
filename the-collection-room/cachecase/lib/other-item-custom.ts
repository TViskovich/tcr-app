import {
  type CustomOtherFormState,
  INITIAL_CUSTOM_OTHER_FORM,
} from '@/components/item-detail/custom-other-details-form';
import {
  compactDetails,
  detailText,
  firstIssue,
  moneyText,
  otherCategoryDisplayName,
  parseOptionalMoney,
  parseOptionalYear,
  requiredText,
  SEARCH_IDENTIFIER_MAX,
  textOrNull,
  textTooLong,
  valueRows,
  yearText,
  type OtherCategoryAdapter,
} from '@/lib/other-items';

// Other → a collector-named category (components/item-detail/
// custom-other-details-form.tsx). The category name itself is
// other_item_details.custom_category_name, set by the screen. Shared
// columns: Item Name → title (required), Brand / Maker → brand, Year,
// Estimated Value, Notes → description; Identifier → search_identifier;
// Purchase Price → private. Condition → details ('custom' spec).

export const customOtherAdapter: OtherCategoryAdapter<CustomOtherFormState> = {
  category: 'custom',
  initialForm: INITIAL_CUSTOM_OTHER_FORM,

  validate(form) {
    return firstIssue(
      requiredText(form.name, 'Item Name', 'Please enter the item name.'),
      textTooLong(form.brand, 200, 'Brand / Maker'),
      textTooLong(form.identifier, SEARCH_IDENTIFIER_MAX, 'Identifier'),
      parseOptionalYear(form.year, 'Year').issue,
      parseOptionalMoney(form.purchasePrice, 'Purchase Price').issue,
      parseOptionalMoney(form.estimatedValue, 'Estimated Value').issue,
    );
  },

  toFields(form) {
    return {
      title: form.name.trim(),
      brand: textOrNull(form.brand),
      year: parseOptionalYear(form.year, 'Year').value,
      estimatedValue: parseOptionalMoney(form.estimatedValue, 'Estimated Value').value,
      description: textOrNull(form.notes),
      searchIdentifier: textOrNull(form.identifier),
      purchasePrice: parseOptionalMoney(form.purchasePrice, 'Purchase Price').value,
      details: compactDetails({ condition: form.condition }),
    };
  },

  fromItem(item, details, privateDetails) {
    return {
      name: item.title ?? '',
      brand: item.brand ?? '',
      year: yearText(item.year),
      identifier: details?.search_identifier ?? '',
      condition: detailText(details, 'condition'),
      purchasePrice: moneyText(privateDetails?.purchase_price),
      estimatedValue: moneyText(item.estimated_value),
      notes: item.description ?? '',
    };
  },

  // Name, then the collector's category, then brand · year.
  identity(item, details) {
    const brandYear = [item.brand, item.year != null ? String(item.year) : null].filter(Boolean).join(' · ') || null;
    return {
      title: item.title?.trim() || 'Untitled Item',
      subtitleLines: [details ? otherCategoryDisplayName(details) : null, brandYear],
    };
  },

  metadataRows(item, details, privateDetails) {
    return [
      { label: 'Category', value: details ? otherCategoryDisplayName(details) : null },
      { label: 'Item Name', value: item.title },
      { label: 'Brand / Maker', value: item.brand },
      { label: 'Year', value: yearText(item.year) },
      { label: 'Identifier', value: details?.search_identifier ?? null },
      { label: 'Condition', value: detailText(details, 'condition') },
      ...valueRows(item, privateDetails),
    ];
  },
};
