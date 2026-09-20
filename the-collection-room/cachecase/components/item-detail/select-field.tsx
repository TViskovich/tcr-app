import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { AnchoredMenu, useAnchoredMenu } from '@/components/profile-v2/profile-v2-anchored-menu';
import { PV2 } from '@/components/profile-v2/profile-v2-theme';

// Generic single/multi-choice dropdown field for a fixed, short option list
// (Printing, Condition, Grading Company, Edition, Special Cover/Finish, Key
// Type, ...) — built from the same AnchoredMenu primitive already proven out
// by app/item/new.tsx's Collectible Type selector (measure trigger, open a
// Modal-hosted box just under it, close on outside tap). Visuals match
// fieldStyles.input/editStyles.input exactly (both screens already use
// identical specs for those), so this drops into either screen's form
// without any per-screen styling.

type SelectFieldProps = {
  label: string;
  value: string | null;
  options: string[];
  placeholder?: string;
  onChange: (value: string) => void;
};

export function SelectField({ label, value, options, placeholder, onChange }: SelectFieldProps) {
  const { open, anchor, triggerRef, openMenu, closeMenu } = useAnchoredMenu();
  return (
    <View style={fieldStyles.wrap}>
      <Text style={fieldStyles.label}>{label}</Text>
      <Pressable
        ref={triggerRef}
        style={fieldStyles.trigger}
        onPress={openMenu}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityHint={`Opens ${label} options`}>
        <Text style={value ? fieldStyles.triggerValue : fieldStyles.triggerPlaceholder} numberOfLines={1}>
          {value || placeholder || `Select ${label}`}
        </Text>
        <Text style={fieldStyles.chevron}>▾</Text>
      </Pressable>

      <AnchoredMenu visible={open} anchor={anchor} onRequestClose={closeMenu}>
        {options.map((option) => {
          const selected = option === value;
          return (
            <Pressable
              key={option}
              style={fieldStyles.menuItem}
              onPress={() => {
                onChange(option);
                closeMenu();
              }}
              accessibilityRole="menuitem"
              accessibilityState={{ selected }}>
              <Text style={[fieldStyles.menuItemLabel, selected && fieldStyles.menuItemLabelSelected]}>
                {option}
              </Text>
              {selected && <Text style={fieldStyles.checkmark}>✓</Text>}
            </Pressable>
          );
        })}
      </AnchoredMenu>
    </View>
  );
}

type MultiSelectFieldProps = {
  label: string;
  values: string[];
  options: string[];
  placeholder?: string;
  onChange: (values: string[]) => void;
};

// Same trigger/menu shell as SelectField, but selecting an item toggles it
// in place and leaves the menu open (an outside tap or the trailing Done row
// closes it) — the one multi-select affordance this app needs (Comics' Key
// Type), so it lives alongside SelectField rather than as a separate
// generic component elsewhere.
export function MultiSelectField({ label, values, options, placeholder, onChange }: MultiSelectFieldProps) {
  const { open, anchor, triggerRef, openMenu, closeMenu } = useAnchoredMenu();
  const [pending, setPending] = useState<string[]>(values);

  function handleOpen() {
    setPending(values);
    openMenu();
  }

  function toggleOption(option: string) {
    setPending((prev) => {
      const next = prev.includes(option) ? prev.filter((v) => v !== option) : [...prev, option];
      onChange(next);
      return next;
    });
  }

  const displayValue = values.length > 0 ? values.join(', ') : '';

  return (
    <View style={fieldStyles.wrap}>
      <Text style={fieldStyles.label}>{label}</Text>
      <Pressable
        ref={triggerRef}
        style={fieldStyles.trigger}
        onPress={handleOpen}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityHint={`Opens ${label} options`}>
        <Text
          style={displayValue ? fieldStyles.triggerValue : fieldStyles.triggerPlaceholder}
          numberOfLines={1}>
          {displayValue || placeholder || `Select ${label}`}
        </Text>
        <Text style={fieldStyles.chevron}>▾</Text>
      </Pressable>

      <AnchoredMenu visible={open} anchor={anchor} onRequestClose={closeMenu}>
        {options.map((option) => {
          const selected = pending.includes(option);
          return (
            <Pressable
              key={option}
              style={fieldStyles.menuItem}
              onPress={() => toggleOption(option)}
              accessibilityRole="menuitem"
              accessibilityState={{ selected }}>
              <Text style={[fieldStyles.menuItemLabel, selected && fieldStyles.menuItemLabelSelected]}>
                {option}
              </Text>
              {selected && <Text style={fieldStyles.checkmark}>✓</Text>}
            </Pressable>
          );
        })}
        <Pressable style={[fieldStyles.menuItem, fieldStyles.doneItem]} onPress={closeMenu}>
          <Text style={fieldStyles.doneLabel}>Done</Text>
        </Pressable>
      </AnchoredMenu>
    </View>
  );
}

const fieldStyles = StyleSheet.create({
  wrap: {
    marginBottom: 12,
  },
  label: {
    fontSize: 13,
    fontWeight: '500',
    color: PV2.textSecondary,
    marginBottom: 4,
  },
  trigger: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 44,
    borderWidth: 1,
    borderColor: PV2.border,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    backgroundColor: PV2.collectorPanelBg,
  },
  triggerValue: {
    flex: 1,
    fontSize: 15,
    color: PV2.textPrimary,
    marginRight: 8,
  },
  triggerPlaceholder: {
    flex: 1,
    fontSize: 15,
    color: PV2.textTertiary,
    marginRight: 8,
  },
  chevron: {
    fontSize: 15,
    color: PV2.textSecondary,
  },
  menuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
    paddingHorizontal: 16,
    gap: 12,
    minWidth: 200,
  },
  menuItemLabel: {
    flex: 1,
    textAlign: 'left',
    fontSize: 15,
    color: PV2.textPrimary,
  },
  menuItemLabelSelected: {
    color: PV2.accent,
    fontWeight: '600',
  },
  checkmark: {
    fontSize: 14,
    color: PV2.accent,
    fontWeight: '700',
  },
  doneItem: {
    justifyContent: 'center',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: PV2.border,
  },
  doneLabel: {
    fontSize: 15,
    fontWeight: '600',
    color: PV2.link,
  },
});
