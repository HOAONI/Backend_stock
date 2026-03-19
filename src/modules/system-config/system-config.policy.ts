import type { ConfigCategory } from './system-config.types';

export const LOCKED_SYSTEM_STRATEGY_EDIT_REASON = '系统保留参数，当前不允许通过后台修改';

export interface SystemConfigFieldPolicy {
  is_editable: boolean;
  visible_in_strategy_page: boolean;
  edit_lock_reason?: string;
}

function isStrategyPageCategory(category: ConfigCategory): boolean {
  return category === 'base' || category === 'backtest';
}

export function getSystemConfigFieldPolicy(input: {
  key: string;
  category: ConfigCategory;
}): SystemConfigFieldPolicy {
  if (!isStrategyPageCategory(input.category)) {
    return {
      is_editable: true,
      visible_in_strategy_page: false,
    };
  }

  return {
    is_editable: false,
    visible_in_strategy_page: false,
    edit_lock_reason: LOCKED_SYSTEM_STRATEGY_EDIT_REASON,
  };
}
