/** 系统配置模块使用的共享类型约定。 */

export type ConfigCategory = 'base' | 'data_source' | 'ai_model' | 'notification' | 'system' | 'backtest' | 'uncategorized';
export type ConfigDataType = 'string' | 'integer' | 'number' | 'boolean' | 'array' | 'json' | 'time';
export type ConfigUiControl = 'text' | 'password' | 'number' | 'select' | 'textarea' | 'switch' | 'time';

export interface ConfigValidationIssue {
  key: string;
  code: string;
  message: string;
  severity: 'error' | 'warning';
  expected?: string;
  actual?: string;
}

export interface ConfigFieldSchema {
  key: string;
  title: string;
  description?: string;
  category: ConfigCategory;
  data_type: ConfigDataType;
  ui_control: ConfigUiControl;
  is_sensitive: boolean;
  is_required: boolean;
  is_editable: boolean;
  visible_in_strategy_page: boolean;
  edit_lock_reason?: string;
  default_value?: string;
  options: string[];
  validation: Record<string, unknown>;
  display_order: number;
}

export interface ConfigCategorySchema {
  category: ConfigCategory;
  title: string;
  description: string;
  display_order: number;
  fields: ConfigFieldSchema[];
}
