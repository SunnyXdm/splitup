import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { PickerSelect } from '@/components/ui/picker-select';
import { currencyPickerOptions } from '@/components/common/currency-options';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { GROUP_EMOJI } from '@/components/group/group-emoji';

export interface GroupFormValues {
  name: string;
  emoji: string;
  currency: string;
}

/** Shared name / emoji / currency fields for the create + edit group dialogs. */
export default function GroupFormFields({
  values,
  onChange,
  currencyLocked = false,
}: {
  values: GroupFormValues;
  onChange: (values: GroupFormValues) => void;
  /** Currency can't change once the group has expenses (server enforces it). */
  currencyLocked?: boolean;
}) {
  return (
    <FieldGroup>
      <Field>
        <FieldLabel htmlFor="group-name">Group name</FieldLabel>
        <Input
          id="group-name"
          value={values.name}
          onChange={(e) => onChange({ ...values, name: e.target.value })}
          placeholder="Trip to Goa"
          maxLength={80}
          autoComplete="off"
        />
      </Field>
      <Field>
        <FieldLabel>Emoji</FieldLabel>
        <ToggleGroup
          value={[values.emoji]}
          onValueChange={(next) => {
            const emoji = next[0];
            if (typeof emoji === 'string') onChange({ ...values, emoji });
          }}
          className="flex-wrap"
          aria-label="Group emoji"
        >
          {GROUP_EMOJI.map((emoji) => (
            <ToggleGroupItem
              key={emoji}
              value={emoji}
              aria-label={`Use ${emoji}`}
              className="size-11 rounded-full text-xl aria-pressed:ring-1 aria-pressed:ring-ring"
            >
              {emoji}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </Field>
      <Field>
        <FieldLabel htmlFor="group-currency">Currency</FieldLabel>
        <PickerSelect
          id="group-currency"
          title="Currency"
          value={values.currency}
          disabled={currencyLocked}
          onValueChange={(currency) => onChange({ ...values, currency })}
          options={currencyPickerOptions()}
        />
        {currencyLocked ? (
          <FieldDescription>
            Currency is locked once a group has expenses.
          </FieldDescription>
        ) : null}
      </Field>
    </FieldGroup>
  );
}
