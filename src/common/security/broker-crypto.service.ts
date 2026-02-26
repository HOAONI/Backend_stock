import * as crypto from 'node:crypto';

import { Injectable } from '@nestjs/common';

export interface EncryptedBrokerPayload {
  ciphertext: string;
  iv: string;
  tag: string;
}

function decodeSecret(secret: string): Buffer {
  const text = secret.trim();
  if (!text) {
    throw new Error('BROKER_SECRET_KEY is required');
  }

  const lower = text.toLowerCase();
  const isHex = /^[0-9a-f]+$/.test(lower) && lower.length % 2 === 0;
  const key = isHex ? Buffer.from(text, 'hex') : Buffer.from(text, 'base64');
  if (key.length !== 32) {
    throw new Error('BROKER_SECRET_KEY must be 32 bytes (hex or base64)');
  }
  return key;
}

@Injectable()
export class BrokerCryptoService {
  private getKey(): Buffer {
    return decodeSecret(String(process.env.BROKER_SECRET_KEY ?? ''));
  }

  encrypt(plainText: string): EncryptedBrokerPayload {
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

  decrypt(input: EncryptedBrokerPayload): string {
    const key = this.getKey();
    const iv = Buffer.from(input.iv, 'base64');
    const tag = Buffer.from(input.tag, 'base64');
    const ciphertext = Buffer.from(input.ciphertext, 'base64');

    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return plain.toString('utf8');
  }
}
