import mongoose from "mongoose";
import bcrypt from "bcrypt";

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
  memo: { type: String },
  teeTotal: Number,
  teeFirstHalf: Number,
  teeSecondHalf: Number,
  teeInRange: Number,
});

// Create a compound index to ensure unique bookings per account and date
bookingSchema.index({ account: 1, date: 1 }, { unique: true });

const userSchema = new mongoose.Schema({
  name: { type: String, required: true },
  password: { type: String, required: true },
  debeachLoginId: { type: String, required: true },
  debeachLoginPassword: { type: String, default: "" },
  granted: { type: Boolean, default: false },
  role: { type: String, enum: ["user", "admin"], default: "user" },
});

userSchema.index({ name: 1, debeachLoginId: 1 }, { unique: true });

userSchema.pre("save", async function (next) {
  if (!this.isModified("password")) return next();
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

userSchema.methods.comparePassword = function (candidatePassword) {
  return bcrypt.compare(candidatePassword, this.password);
};

userSchema.methods.setPassword = async function (nextPassword) {
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(nextPassword, salt);
};

const messageSchema = new mongoose.Schema(
  {
    roomKey: { type: String, required: true, index: true },
    adminUsername: { type: String, required: true },
    userUsername: { type: String, required: true },
    senderUsername: { type: String, required: true },
    senderRole: { type: String, enum: ["user", "admin"], required: true },
    body: { type: String, required: true },
    readBy: [{ type: String }],
    bookingContext: {
      account: { type: String, default: "" },
      date: { type: String, default: "" },
      startTime: { type: String, default: "" },
      endTime: { type: String, default: "" },
      memo: { type: String, default: "" },
      status: { type: String, default: "" },
      bookedTime: { type: String, default: "" },
    },
  },
  { timestamps: true },
);

const passwordChangeRequestSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    requesterName: { type: String, required: true },
    newPassword: { type: String, required: true },
    requestType: {
      type: String,
      enum: ["app_password", "debeach_password"],
      default: "app_password",
      index: true,
    },
    status: {
      type: String,
      enum: ["pending", "approved", "rejected"],
      default: "pending",
      index: true,
    },
    rejectReason: { type: String, default: "" },
    reviewedBy: { type: String, default: "" },
    reviewedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

export const User = mongoose.model("User", userSchema);
export const AvailableSlot = mongoose.model(
  "AvailableSlot",
  availableSlotSchema,
);
export const Booking = mongoose.model("Booking", bookingSchema);
export const Message = mongoose.model("Message", messageSchema);
export const PasswordChangeRequest = mongoose.model(
  "PasswordChangeRequest",
  passwordChangeRequestSchema,
);
