/** 运行时类型声明使用的共享类型约定。 */

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
