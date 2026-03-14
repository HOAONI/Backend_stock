import * as crypto from 'node:crypto';

import { Injectable } from '@nestjs/common';

export interface EncryptedPayload {
  ciphertext: string;
  iv: string;
  tag: string;
}

export interface PersonalSecretStatus {
  available: boolean;
  issue: string;
}

const PERSONAL_SECRET_KEY_SETUP_HINT = '请在 Backend_stock/.env 中配置有效的 PERSONAL_SECRET_KEY 后重启后端，可使用 openssl rand -hex 32 生成。';

function decodeSecret(secret: string): Buffer {
  const text = secret.trim();
  if (!text) {
    throw new Error('PERSONAL_SECRET_KEY is required');
  }

  const hex = text.toLowerCase();
  const isHex = /^[0-9a-f]+$/.test(hex) && hex.length % 2 === 0;
  const raw = isHex ? Buffer.from(text, 'hex') : Buffer.from(text, 'base64');
  if (raw.length !== 32) {
    throw new Error('PERSONAL_SECRET_KEY must be 32 bytes (hex or base64)');
  }
  return raw;
}

export function getPersonalSecretStatus(secret = String(process.env.PERSONAL_SECRET_KEY ?? '')): PersonalSecretStatus {
  const text = secret.trim();
  if (!text) {
    return {
      available: false,
      issue: `后端尚未配置 PERSONAL_SECRET_KEY，${PERSONAL_SECRET_KEY_SETUP_HINT}`,
    };
  }

  try {
    decodeSecret(text);
    return {
      available: true,
      issue: '',
    };
  } catch {
    return {
      available: false,
      issue: `后端的 PERSONAL_SECRET_KEY 格式无效，需为 32 字节的 hex 或 base64。${PERSONAL_SECRET_KEY_SETUP_HINT}`,
    };
  }
}

@Injectable()
export class PersonalCryptoService {
  getStatus(): PersonalSecretStatus {
    return getPersonalSecretStatus();
  }

  assertAvailable(): void {
    const status = this.getStatus();
    if (!status.available) {
      throw new Error(status.issue);
    }
  }

  private getKey(): Buffer {
    this.assertAvailable();
    return decodeSecret(String(process.env.PERSONAL_SECRET_KEY ?? ''));
  }

  encrypt(plainText: string): EncryptedPayload {
    const key = this.getKey();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();

    return {
      ciphertext: ciphertext.toString('base64'),
      iv: iv.toString('base64'),
      tag: tag.toString('base64'),
    };
  }

  decrypt(input: EncryptedPayload): string {
    const key = this.getKey();
    const iv = Buffer.from(input.iv, 'base64');
    const tag = Buffer.from(input.tag, 'base64');
    const ciphertext = Buffer.from(input.ciphertext, 'base64');

    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return decrypted.toString('utf8');
  }
}
