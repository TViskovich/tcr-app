import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import { SelectField } from '@/components/item-detail/select-field';
import { PV2 } from '@/components/profile-v2/profile-v2-theme';

// "Graded" control for the Add/Edit Item forms whose grading data is just
// Grade + Grading Company (Sports Card, Pokémon). There is no stored graded
// flag — callers derive `graded` from whether either value exists, and clear
// both values when it is set back to "-", so hidden grading data is never
// saved. Uses the forms' existing SelectField dropdown in its compact inline
// layout; "-" means ungraded and there is deliberately no "No" option.

const UNGRADED = '-';
const GRADED = 'Yes';
const OPTIONS = [UNGRADED, GRADED];

type GradedToggleProps = {
  graded: boolean;
  onChange: (graded: boolean) => void;
  children: ReactNode;
};

export function GradedToggle({ graded, onChange, children }: GradedToggleProps) {
  return (
    <>
      <SelectField
        inline
        label="Graded"
        value={graded ? GRADED : UNGRADED}
        options={OPTIONS}
        onChange={(v) => onChange(v === GRADED)}
      />
      {graded && <View style={styles.nested}>{children}</View>}
    </>
  );
}

const NO_COMPANY = '-';

// Grading Company dropdown shown under a "Yes" Graded row: "-" (none) plus
// the category's list (lib/card-grading-options.ts). A saved company that
// isn't in the list (older free-text entries) is appended as its own choice
// and shown as selected, so editing an item never drops or rewrites it.
export function GradingCompanyField({
  companies,
  value,
  onChange,
}: {
  companies: string[];
  value: string;
  onChange: (value: string) => void;
}) {
  const saved = value.trim();
  const options =
    saved && !companies.includes(saved) ? [NO_COMPANY, ...companies, saved] : [NO_COMPANY, ...companies];
  return (
    <SelectField
      label="Grading Company"
      value={saved || NO_COMPANY}
      options={options}
      onChange={(v) => onChange(v === NO_COMPANY ? '' : v)}
    />
  );
}

const styles = StyleSheet.create({
  // Indented with a left rule so the revealed fields read as belonging to
  // the Graded row above them.
  nested: {
    marginLeft: 6,
    paddingLeft: 12,
    borderLeftWidth: 2,
    borderLeftColor: PV2.border,
  },
});
