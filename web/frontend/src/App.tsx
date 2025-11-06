import { useState, useEffect } from "react";
import Calendar from "react-calendar";
import moment from "moment";
import { User } from "lucide-react";
import NewBookingForm from "./NewBookingForm";

const AccountManager = ({
  isOpen,
  onClose,
}: {
  isOpen: boolean;
  onClose: () => void;
}) => {
  if (!isOpen) return null;
  return (
    <div
      className="fixed inset-0 bg-black bg-opacity-60 flex justify-center items-center z-50 p-4"
      onClick={onClose}
    >
      <div
        className="bg-white dark:bg-gray-800 p-6 rounded-2xl shadow-xl w-full max-w-md"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-2xl font-bold mb-4 text-gray-900 dark:text-white">
          Manage Accounts
        </h2>
        <p className="text-gray-600 dark:text-gray-300">
          Account management interface will be here.
        </p>
      </div>
    </div>
  );
};

interface Booking {
  account: string;
  status: "예약" | "접수" | "재시도" | "성공" | "실패";
  successTime?: string | null;
  bookedSlot?: { bk_time: string; bk_cours: string } | null;
  startTime: string;
  endTime: string;
}

type BookingsByDate = Record<string, Booking[]>;

function App() {
  const [bookings, setBookings] = useState<BookingsByDate>({});
  const [selectedDate, setSelectedDate] = useState(new Date());
  const [selectedBooking, setSelectedBooking] = useState<Booking | null>(null);
  const [activeMonth, setActiveMonth] = useState(new Date());
  const [isNewBookingModalOpen, setIsNewBookingModalOpen] = useState(false);
  const [isAccountModalOpen, setIsAccountModalOpen] = useState(false);

  const statusLegend: Record<Booking["status"], string> = {
    성공: "bg-green-500",
    실패: "bg-red-500",
    예약: "bg-blue-500",
    접수: "bg-yellow-500",
    재시도: "bg-gray-400",
  };

  const getStatusColor = (status: Booking["status"]) => {
    return statusLegend[status] || "bg-gray-400";
  };

  const fetchBookings = async () => {
    try {
      const response = await fetch("http://localhost:3001/api/bookings");
      const data: BookingsByDate = await response.json();
      setBookings(data);
    } catch (error) {
      console.error("Failed to fetch bookings:", error);
    }
  };

  useEffect(() => {
    fetchBookings();
  }, []);

  const handleDayClick = (date: Date) => {
    setSelectedDate(date);
    setIsNewBookingModalOpen(true);
  };

  const handleBookingClick = (booking: Booking, date: Date) => {
    setSelectedDate(date);
    setSelectedBooking(booking);
    setIsNewBookingModalOpen(true);
  };

  const handleUpdateBooking = async (updatedBooking: {
    startTime: string;
    endTime: string;
  }) => {
    if (!selectedBooking || !selectedDate) return;

    try {
      const response = await fetch(
        `http://localhost:3001/api/bookings/${moment(selectedDate).format(
          "YYYYMMDD"
        )}/${selectedBooking.account}`,
        {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(updatedBooking),
        }
      );

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.message || "Failed to update booking.");
      }

      fetchBookings();
      setIsNewBookingModalOpen(false);
      setSelectedBooking(null);
    } catch (error) {
      console.error("Error updating booking:", error);
    }
  };

  const handleDeleteBooking = async () => {
    if (!selectedBooking || !selectedDate) return;

    try {
      const response = await fetch(
        `http://localhost:3001/api/bookings/${moment(selectedDate).format(
          "YYYYMMDD"
        )}/${selectedBooking.account}`,
        {
          method: "DELETE",
        }
      );

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.message || "Failed to delete booking.");
      }

      // Refresh bookings and close modal
      fetchBookings();
      setIsNewBookingModalOpen(false);
      setSelectedBooking(null);
    } catch (error) {
      console.error("Error deleting booking:", error);
      // You might want to show an error message to the user here
    }
  };

  const getTileContent = ({ date, view }: { date: Date; view: string }) => {
    if (view !== "month") return null;
    const dateStr = moment(date).format("YYYYMMDD");
    const dayBookings = bookings[dateStr] || [];

    return (
      <div className="flex flex-col items-stretch text-xs mt-1 space-y-1 p-1 h-full">
        {dayBookings.map((booking, index) => (
          <button
            key={index}
            onClick={(e) => {
              e.stopPropagation();
              handleBookingClick(booking, date);
            }}
            className={`w-full text-white rounded-md text-center text-[10px] leading-tight py-1 ${getStatusColor(
              booking.status
            )}`}
          >
            {booking.account}
          </button>
        ))}
      </div>
    );
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-50 to-gray-200 dark:from-gray-800 dark:to-gray-900">
      <div className="container mx-auto p-4 sm:p-6 lg:p-8 max-w-7xl">
        <header className="relative flex justify-between items-center mb-10">
          <div className="flex justify-center flex-wrap gap-x-4 gap-y-2">
            {Object.entries(statusLegend).map(([status, color]) => (
              <div
                key={status}
                className={`px-3 py-1 text-sm rounded-full text-white ${color}`}
              >
                {status}
              </div>
            ))}
          </div>

          <button
            onClick={() => setIsAccountModalOpen(true)}
            className="p-2 rounded-full bg-white/50 dark:bg-gray-700/50 hover:bg-white dark:hover:bg-gray-600"
          >
            <User className="h-6 w-6 text-gray-600 dark:text-gray-300" />
          </button>
        </header>

        <main>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
            <div className="bg-white/80 dark:bg-gray-800/50 backdrop-blur-sm p-4 sm:p-6 rounded-2xl shadow-lg">
              <Calendar
                onClickDay={handleDayClick}
                value={activeMonth}
                tileContent={getTileContent}
                onActiveStartDateChange={({ activeStartDate }) =>
                  setActiveMonth(activeStartDate || new Date())
                }
                locale="en-US"
              />
            </div>
            <div className="bg-white/80 dark:bg-gray-800/50 backdrop-blur-sm p-4 sm:p-6 rounded-2xl shadow-lg">
              <Calendar
                onClickDay={handleDayClick}
                tileContent={getTileContent}
                locale="en-US"
                activeStartDate={
                  new Date(
                    activeMonth.getFullYear(),
                    activeMonth.getMonth() + 1,
                    1
                  )
                }
                onActiveStartDateChange={() => {}} // Prevent navigation on the second calendar
              />
            </div>
          </div>
        </main>
      </div>

      <NewBookingForm
        selectedDate={selectedDate}
        onBookingAdded={() => {
          fetchBookings();
          setIsNewBookingModalOpen(false);
          setSelectedBooking(null); // Reset editing booking
        }}
        onBookingUpdated={handleUpdateBooking}
        onBookingDeleted={() => {
          handleDeleteBooking();
          setIsNewBookingModalOpen(false);
        }}
        isOpen={isNewBookingModalOpen}
        onClose={() => {
          setIsNewBookingModalOpen(false);
          setSelectedBooking(null); // Reset editing booking on close
        }}
        editingBooking={selectedBooking}
      />

      <AccountManager
        isOpen={isAccountModalOpen}
        onClose={() => setIsAccountModalOpen(false)}
      />
    </div>
  );
}

export default App;
