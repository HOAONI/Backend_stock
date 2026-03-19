import { LOCKED_SYSTEM_STRATEGY_EDIT_REASON } from '../src/modules/system-config/system-config.policy';
import { SystemConfigService } from '../src/modules/system-config/system-config.service';

function createPrismaMock(input?: {
  rows?: Array<Record<string, unknown>>;
  version?: string;
}) {
  return {
    systemConfigItem: {
      count: jest.fn(async () => 1),
      findMany: jest.fn(async () => input?.rows ?? []),
      upsert: jest.fn(async ({ create, update }: Record<string, any>) => ({ ...create, ...update })),
      createMany: jest.fn(async () => ({ count: 0 })),
    },
    systemConfigRevision: {
      findFirst: jest.fn(async () => ({ version: input?.version ?? 'version-1' })),
      create: jest.fn(async () => ({ version: 'version-2' })),
    },
  };
}

describe('SystemConfigService', () => {
  it('marks former strategy page keys as hidden and read-only in schema payloads', async () => {
    const prisma = createPrismaMock({
      rows: [
        {
          key: 'BACKTEST_EVAL_WINDOW_DAYS',
          value: '10',
          category: 'backtest',
          dataType: 'integer',
          uiControl: 'number',
          isSensitive: false,
          displayOrder: 1,
          updatedAt: new Date('2026-03-18T00:00:00.000Z'),
        },
        {
          key: 'PORT',
          value: '8002',
          category: 'system',
          dataType: 'integer',
          uiControl: 'number',
          isSensitive: false,
          displayOrder: 2,
          updatedAt: new Date('2026-03-18T00:00:00.000Z'),
        },
      ],
    });
    const service = new SystemConfigService(prisma as any);

    const payload = await service.getConfig(true) as { items: Array<Record<string, any>> };
    const lockedItem = payload.items.find(item => item.key === 'BACKTEST_EVAL_WINDOW_DAYS');
    const editableItem = payload.items.find(item => item.key === 'PORT');

    expect(lockedItem?.schema).toMatchObject({
      is_editable: false,
      visible_in_strategy_page: false,
      edit_lock_reason: LOCKED_SYSTEM_STRATEGY_EDIT_REASON,
    });
    expect(editableItem?.schema).toMatchObject({
      is_editable: true,
      visible_in_strategy_page: false,
    });
  });

  it('rejects writes to locked strategy keys before persisting updates', async () => {
    const prisma = createPrismaMock();
    const service = new SystemConfigService(prisma as any);

    try {
      await service.updateConfig({
        configVersion: 'version-1',
        items: [{ key: 'BACKTEST_EVAL_WINDOW_DAYS', value: '30' }],
      });
      throw new Error('expected locked key update to fail');
    } catch (error: any) {
      expect(error.code).toBe('VALIDATION_ERROR');
      expect(error.issues).toEqual([
        expect.objectContaining({
          key: 'BACKTEST_EVAL_WINDOW_DAYS',
          code: 'readonly_key',
          message: LOCKED_SYSTEM_STRATEGY_EDIT_REASON,
        }),
      ]);
    }

    expect(prisma.systemConfigItem.upsert).not.toHaveBeenCalled();
  });

  it('still persists unrelated editable system config keys', async () => {
    const prisma = createPrismaMock();
    const service = new SystemConfigService(prisma as any);

    const result = await service.updateConfig({
      configVersion: 'version-1',
      items: [{ key: 'PORT', value: '9000' }],
    }) as Record<string, any>;

    expect(result.success).toBe(true);
    expect(result.updated_keys).toEqual(['PORT']);
    expect(prisma.systemConfigItem.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { key: 'PORT' },
      update: expect.objectContaining({
        value: '9000',
      }),
    }));
  });
});
