import mongoose from 'mongoose';

const availableSlotSchema = new mongoose.Schema({
  date: { type: String, required: true },
  bk_cours: String,
  bk_part: String,
  bk_time: String,
  bk_hole: String,
  bk_base_greenfee: String,
  bk_green_fee: String,
  bk_event: String,
  bk_green_sale_rate: String,
  bk_cours_name: String,
});

const bookingSchema = new mongoose.Schema({
  account: { type: String, required: true },
  date: { type: String, required: true },
  status: String,
  startTime: String,
  endTime: String,
  successTime: String,
  bookedSlot: availableSlotSchema, // Embed the slot schema
});

// Create a compound index to ensure unique bookings per account and date
bookingSchema.index({ account: 1, date: 1 }, { unique: true });

const accountSchema = new mongoose.Schema({
  name: { type: String, required: true, unique: true },
  loginId: { type: String, required: true },
  loginPassword: { type: String, required: true },
});

export const Account = mongoose.model('Account', accountSchema);
export const AvailableSlot = mongoose.model('AvailableSlot', availableSlotSchema);
export const Booking = mongoose.model('Booking', bookingSchema);
