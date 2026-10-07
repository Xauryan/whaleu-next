import { z } from 'zod';
export const textSchema = (maximum: number) =>
  z
    .string()
    .transform((value) => value.replaceAll('\r\n', '\n'))
    .refine(
      (value) =>
        [...value].length <= maximum &&
        [...value].every((character) => {
          const code = character.codePointAt(0)!;
          return (
            code === 9 ||
            code === 10 ||
            (code >= 32 &&
              !(code >= 127 && code <= 159) &&
              !(code >= 0xd800 && code <= 0xdfff))
          );
        }),
    );
