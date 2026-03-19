import mongoose from "mongoose";

mongoose.set("bufferCommands", false);

const connectDB = async () => {
  if (mongoose.connection.readyState >= 1) {
    return;
  }

  try {
    if (!process.env.MONGODB_URI) {
      throw new Error("MONGODB_URI environment variable is not set");
    }
    await mongoose.connect(process.env.MONGODB_URI);
    console.log("MongoDB connected successfully.");
  } catch (error) {
    console.error("MongoDB connection error:", error);
    // process.exit(1); // Optionally exit if DB connection is critical
  }
};

export default connectDB;
