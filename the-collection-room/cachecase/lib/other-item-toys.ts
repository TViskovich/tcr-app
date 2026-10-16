import { INITIAL_TOY_FORM, type ToyFormState } from '@/components/item-detail/toy-details-form';
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
  type OtherCategoryAdapter,
} from '@/lib/other-items';

// Other → Toys (components/item-detail/toy-details-form.tsx). Shared
// columns: Character / Item Name → title (required), Brand / Manufacturer →
// brand, Year → year, Estimated Value, Notes → description; Item / Model
// Number → search_identifier; Purchase Price → private. The rest → details
// ('toys' spec in supabase/migrations/
// 20261024120000_add_other_item_details.sql).
//
// Only the fields the form is showing are saved, with the form's own rules:
// wave for action figures (or no type yet), package condition unless loose,
// missing pieces when incomplete, grading when graded, and the die-cast /
// plush / electronic sections only for their toy type.

function sections(form: ToyFormState) {
  return {
    showWave: form.toyType === 'Action Figure' || !form.toyType,
    showPackageIssues: form.packaging !== 'Loose',
    showMissing: form.accessories === 'Incomplete',
    showVariantDetails: form.variants.length > 0,
    isDiecast: form.toyType === 'Die-cast',
    isPlush: form.toyType === 'Plush',
    isElectronic: form.toyType === 'Electronic',
  };
}

export const toyAdapter: OtherCategoryAdapter<ToyFormState> = {
  category: 'toys',
  initialForm: INITIAL_TOY_FORM,

  validate(form) {
    const s = sections(form);
    return firstIssue(
      requiredText(form.name, 'Character / Item Name', 'Please enter the character or item name.'),
      unspecifiedOption(form.brand, 'Brand'),
      unspecifiedOption(form.exclusive, 'Exclusive'),
      form.graded ? unspecifiedOption(form.gradingCompany, 'Grading Company') : null,
      s.isDiecast ? unspecifiedOption(form.diecastScale, 'Scale') : null,
      textTooLong(form.itemNumber, SEARCH_IDENTIFIER_MAX, 'Item / Model Number'),
      textTooLong(form.line, 120, 'Line / Series'),
      s.showWave ? textTooLong(form.wave, 60, 'Wave / Assortment') : null,
      s.showVariantDetails ? textTooLong(form.variantDetails, 200, 'Variant Details') : null,
      s.showMissing ? textTooLong(form.missingPieces, 200, 'Missing Pieces') : null,
      form.graded ? textTooLong(form.grade, 20, 'Grade') : null,
      s.isDiecast ? textTooLong(form.castingName, 120, 'Casting Name') : null,
      parseOptionalYear(form.year, 'Year').issue,
      parseOptionalMoney(form.purchasePrice, 'Purchase Price').issue,
      parseOptionalMoney(form.estimatedValue, 'Estimated Value').issue,
    );
  },

  toFields(form) {
    const s = sections(form);
    return {
      title: form.name.trim(),
      brand: textOrNull(form.brand),
      year: parseOptionalYear(form.year, 'Year').value,
      estimatedValue: parseOptionalMoney(form.estimatedValue, 'Estimated Value').value,
      description: textOrNull(form.notes),
      searchIdentifier: textOrNull(form.itemNumber),
      purchasePrice: parseOptionalMoney(form.purchasePrice, 'Purchase Price').value,
      details: compactDetails({
        toy_type: form.toyType,
        line: form.line,
        release: form.release,
        wave: s.showWave ? form.wave : null,
        variants: form.variants,
        variant_details: s.showVariantDetails ? form.variantDetails : null,
        exclusive: form.exclusive,
        packaging: form.packaging,
        package_issues: s.showPackageIssues ? form.packageIssues : null,
        accessories: form.accessories,
        missing_pieces: s.showMissing ? form.missingPieces : null,
        condition: form.condition,
        condition_issues: form.conditionIssues,
        graded: form.graded,
        grading_company: form.graded ? form.gradingCompany : null,
        grade: form.graded ? form.grade : null,
        diecast_scale: s.isDiecast ? form.diecastScale : null,
        treasure_hunt: s.isDiecast ? form.treasureHunt : null,
        casting_name: s.isDiecast ? form.castingName : null,
        hang_tag: s.isPlush ? form.hangTag : null,
        tush_tag: s.isPlush ? form.tushTag : null,
        working: s.isElectronic ? form.working : null,
        battery_corrosion: s.isElectronic ? form.batteryCorrosion : null,
      }),
    };
  },

  fromItem(item, details, privateDetails) {
    return {
      toyType: detailText(details, 'toy_type'),
      brand: item.brand ?? '',
      line: detailText(details, 'line'),
      name: item.title ?? '',
      year: yearText(item.year),
      release: detailText(details, 'release'),
      itemNumber: details?.search_identifier ?? '',
      wave: detailText(details, 'wave'),
      variants: detailList(details, 'variants'),
      variantDetails: detailText(details, 'variant_details'),
      exclusive: detailText(details, 'exclusive'),
      packaging: detailText(details, 'packaging'),
      packageIssues: detailList(details, 'package_issues'),
      accessories: detailText(details, 'accessories'),
      missingPieces: detailText(details, 'missing_pieces'),
      condition: detailText(details, 'condition'),
      conditionIssues: detailList(details, 'condition_issues'),
      graded: detailBool(details, 'graded'),
      gradingCompany: detailText(details, 'grading_company'),
      grade: detailText(details, 'grade'),
      diecastScale: detailText(details, 'diecast_scale'),
      treasureHunt: detailText(details, 'treasure_hunt'),
      castingName: detailText(details, 'casting_name'),
      hangTag: detailText(details, 'hang_tag'),
      tushTag: detailText(details, 'tush_tag'),
      working: detailText(details, 'working'),
      batteryCorrosion: detailText(details, 'battery_corrosion'),
      purchasePrice: moneyText(privateDetails?.purchase_price),
      estimatedValue: moneyText(item.estimated_value),
      notes: item.description ?? '',
    };
  },

  // Name, then line, then brand · year, then packaging.
  identity(item, details) {
    const brandYear = [item.brand, item.year != null ? String(item.year) : null].filter(Boolean).join(' · ') || null;
    return {
      title: item.title?.trim() || 'Untitled Item',
      subtitleLines: [detailText(details, 'line') || null, brandYear, detailText(details, 'packaging') || null],
    };
  },

  metadataRows(item, details, privateDetails) {
    const company = detailText(details, 'grading_company');
    const grade = detailText(details, 'grade');
    return [
      { label: 'Toy Type', value: detailText(details, 'toy_type') },
      { label: 'Brand / Manufacturer', value: item.brand },
      { label: 'Line / Series', value: detailText(details, 'line') },
      { label: 'Character / Item Name', value: item.title },
      { label: 'Year', value: yearText(item.year) },
      { label: 'Release', value: detailText(details, 'release') },
      { label: 'Item / Model Number', value: details?.search_identifier ?? null },
      { label: 'Wave / Assortment', value: detailText(details, 'wave') },
      { label: 'Variant', value: detailList(details, 'variants').join(', ') },
      { label: 'Variant Details', value: detailText(details, 'variant_details') },
      { label: 'Exclusive', value: detailText(details, 'exclusive') },
      { label: 'Packaging', value: detailText(details, 'packaging') },
      { label: 'Package Condition', value: detailList(details, 'package_issues').join(', ') },
      { label: 'Accessories', value: detailText(details, 'accessories') },
      { label: 'Missing Pieces', value: detailText(details, 'missing_pieces') },
      { label: 'Condition', value: detailText(details, 'condition') },
      { label: 'Condition Notes', value: detailList(details, 'condition_issues').join(', ') },
      { label: 'Graded', value: detailBool(details, 'graded') ? [company, grade].filter(Boolean).join(' ') || 'Yes' : null },
      { label: 'Scale', value: detailText(details, 'diecast_scale') },
      { label: 'Treasure Hunt', value: detailText(details, 'treasure_hunt') },
      { label: 'Casting Name', value: detailText(details, 'casting_name') },
      { label: 'Hang Tag', value: detailText(details, 'hang_tag') },
      { label: 'Tush Tag', value: detailText(details, 'tush_tag') },
      { label: 'Working Condition', value: detailText(details, 'working') },
      { label: 'Battery Corrosion', value: detailText(details, 'battery_corrosion') },
      ...valueRows(item, privateDetails),
    ];
  },
};
