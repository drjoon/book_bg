import mongoose from 'mongoose';
import bcrypt from 'bcrypt';

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

const userSchema = new mongoose.Schema({
  name: { type: String, required: true },
  username: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  golfPassword: { type: String },
  granted: { type: Boolean, default: false },
  role: { type: String, enum: ['user', 'admin'], default: 'user' },
});

userSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

userSchema.methods.comparePassword = function (candidatePassword) {
  return bcrypt.compare(candidatePassword, this.password);
};

export const User = mongoose.model('User', userSchema);
export const AvailableSlot = mongoose.model('AvailableSlot', availableSlotSchema);
export const Booking = mongoose.model('Booking', bookingSchema);
