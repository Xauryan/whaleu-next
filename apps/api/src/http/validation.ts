import { BadRequestException } from '@nestjs/common';
import type { PipeTransform } from '@nestjs/common';
import type { z } from 'zod';

export class SchemaValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: z.ZodType<T>) {}

  transform(value: unknown): T {
    const parsed = this.schema.safeParse(value);
    if (!parsed.success) {
      // Do not return input values, refinements, or arbitrary schema messages to clients.
      throw new BadRequestException('Invalid request');
    }
    return parsed.data;
  }
}
