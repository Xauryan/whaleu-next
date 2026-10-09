import { Injectable } from '@nestjs/common';
import { randomInt } from 'node:crypto';
import { ApplicationError } from '../../http/application-error.js';
/** Internal randomness seam. Neither a seed nor an index is accepted over HTTP. */
@Injectable()
export class RatingRandomDraw {
  index(size: number): number {
    if (!Number.isSafeInteger(size) || size < 1 || size >= 2 ** 48)
      throw new ApplicationError('RATING_UNAVAILABLE');
    return randomInt(size);
  }
}
