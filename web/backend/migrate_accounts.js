import mongoose from 'mongoose';
import fs from 'fs/promises';
import path from 'path';
import dotenv from 'dotenv';
import { Account } from './models.js';

import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '.env') });

const CONFIG_PATH = path.resolve(__dirname, '../../auto/booking_configs.json');

async function migrateAccounts() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('MongoDB connected for account migration.');

    const configs = JSON.parse(await fs.readFile(CONFIG_PATH, 'utf-8'));
    
    await Account.deleteMany({}); // Clear existing accounts

    for (const config of configs) {
      const account = new Account({
        name: config.NAME,
        loginId: config.LOGIN_ID,
        loginPassword: config.LOGIN_PASSWORD,
      });
      await account.save();
      console.log(`Migrated account: ${config.NAME}`);
    }

    console.log('Account migration finished successfully.');

  } catch (error) {
    if (error.code === 11000) {
      console.log(`Account already exists, skipping.`);
    } else {
      console.error('Migration failed:', error);
    }
  } finally {
    await mongoose.disconnect();
    console.log('MongoDB disconnected.');
  }
}

migrateAccounts();
