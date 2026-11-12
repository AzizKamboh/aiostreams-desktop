import { Option } from '@aiostreams/core';

export function redactPresetOptions(
  options: Record<string, any> | undefined,
  optionMeta: Option[] | undefined,
  placeholder?: string
): Record<string, any> {
  return Object.fromEntries(
    Object.entries(options ?? {}).flatMap(([id, value]): [string, any][] => {
      const meta = optionMeta?.find((opt) => opt.id === id);
      if (meta?.type === 'password') {
        return placeholder !== undefined && value !== undefined && value !== ''
          ? [[id, placeholder]]
          : [];
      }
      const subOptions = meta?.subOptions as Option[] | undefined;
      if (
        subOptions?.length &&
        value &&
        typeof value === 'object' &&
        !Array.isArray(value)
      ) {
        return [[id, redactPresetOptions(value, subOptions, placeholder)]];
      }
      return [[id, value]];
    })
  );
}
