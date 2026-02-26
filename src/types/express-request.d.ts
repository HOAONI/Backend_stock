import 'express';

import type { AuthenticatedUserContext } from '../common/auth/auth.types';

declare global {
  namespace Express {
    interface Request {
      authUser?: AuthenticatedUserContext;
    }
  }
}

export {};
