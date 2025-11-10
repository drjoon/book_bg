import { useState, useEffect } from "react";
import Calendar from "react-calendar";
import moment from "moment";
import { User, LogOut } from "lucide-react";
import useAuthStore from "@/store/authStore";
import { API_BASE_URL } from "../config";
import NewBookingForm from "../NewBookingForm";
import axios from "axios";

interface ManagedUser {
  _id: string;
  name: string;
  username: string;
  granted: boolean;
  role: "user" | "admin";
}

const AccountManager = ({
  isOpen,
  onClose,
}: {
  isOpen: boolean;
  onClose: () => void;
}) => {
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const user = useAuthStore((state) => state.user);
  const setUser = useAuthStore((state) => state.setUser);
  const [golfPassword, setGolfPassword] = useState(user?.golfPassword ?? "");
  const [saving, setSaving] = useState(false);

  const fetchUsers = async () => {
    if (user?.role !== "admin") return;
    try {
      const response = await axios.get(`${API_BASE_URL}/api/users`);
      setUsers(response.data);
    } catch (error) {
      console.error("Failed to fetch users:", error);
    }
  };

  useEffect(() => {
    if (isOpen && user?.role === "admin") {
      fetchUsers();
    }
  }, [isOpen, user?.role]);

  useEffect(() => {
    if (isOpen) {
      setGolfPassword(user?.golfPassword ?? "");
    }
  }, [isOpen, user?.golfPassword]);

  const handleUserUpdate = async (
    userId: string,
    data: Partial<ManagedUser>
  ) => {
    try {
      await axios.put(`${API_BASE_URL}/api/users/${userId}`, data);
      setUsers((prev) =>
        prev.map((u) => (u._id === userId ? { ...u, ...data } : u))
      );
    } catch (error) {
      console.error("Failed to update user:", error);
    }
  };

  const handleSaveGolfPassword = async () => {
    if (!user) return;
    try {
      setSaving(true);
      const response = await axios.put(`${API_BASE_URL}/api/profile/golf-password`, {
        golfPassword,
      });
      setUser({
        ...user,
        golfPassword: response.data.user.golfPassword,
      });
      onClose();
    } catch (error) {
      console.error("Failed to save golf password:", error);
    } finally {
      setSaving(false);
    }
  };

  if (!isOpen) return null;

  if (user?.role !== "admin") {
    return (
      <div
        className="fixed inset-0 bg-black bg-opacity-60 flex justify-center items-center z-50 p-4"
        onClick={onClose}
      >
        <div
          className="bg-white dark:bg-gray-800 p-6 rounded-2xl shadow-xl w-full max-w-md"
          onClick={(e) => e.stopPropagation()}
        >
          <h2 className="text-2xl font-bold mb-4 text-gray-900 dark:text-white">내 정보</h2>
          <div className="space-y-4">
            <div>
              <p className="text-sm text-gray-500">계정명</p>
              <p className="font-semibold text-gray-900 dark:text-white">{user?.name}</p>
            </div>
            <div>
              <p className="text-sm text-gray-500">아이디</p>
              <p className="font-semibold text-gray-900 dark:text-white">{user?.username}</p>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium text-gray-700 dark:text-gray-200">
                골프장 비밀번호
              </label>
              <input
                type="password"
                value={golfPassword}
                onChange={(e) => setGolfPassword(e.target.value)}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <p className="text-xs text-gray-500">
                자동 예약에 사용될 비밀번호입니다. 변경 후 저장해주세요.
              </p>
            </div>
          </div>
          <div className="mt-6 flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-md bg-gray-100 text-gray-700 hover:bg-gray-200"
            >
              닫기
            </button>
            <button
              type="button"
              onClick={handleSaveGolfPassword}
              disabled={saving}
              className="px-4 py-2 rounded-md bg-blue-500 text-white hover:bg-blue-600 disabled:opacity-60"
            >
              {saving ? "저장 중..." : "저장"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className="fixed inset-0 bg-black bg-opacity-60 flex justify-center items-center z-50 p-4"
      onClick={onClose}
    >
      <div
        className="bg-white dark:bg-gray-800 p-6 rounded-2xl shadow-xl w-full max-w-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-2xl font-bold mb-4 text-gray-900 dark:text-white">사용자 관리</h2>
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 py-2 text-left text-sm font-semibold text-gray-600">
                  Name
                </th>
                <th className="px-4 py-2 text-left text-sm font-semibold text-gray-600">
                  Username
                </th>
                <th className="px-4 py-2 text-left text-sm font-semibold text-gray-600">
                  Granted
                </th>
                <th className="px-4 py-2 text-left text-sm font-semibold text-gray-600">
                  Role
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {users.map((user) => (
                <tr key={user._id}>
                  <td className="px-4 py-2 text-sm text-gray-100">
                    {user.name}
                  </td>
                  <td className="px-4 py-2 text-sm text-gray-100">
                    {user.username}
                  </td>
                  <td className="px-4 py-2 text-sm text-gray-100">
                    <input
                      type="checkbox"
                      checked={user.granted}
                      onChange={(event) =>
                        handleUserUpdate(user._id, {
                          granted: event.target.checked,
                        })
                      }
                      className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                    />
                  </td>
                  <td className="px-4 py-2 text-sm text-gray-800">
                    <select
                      value={user.role}
                      onChange={(event) =>
                        handleUserUpdate(user._id, {
                          role: event.target.value as "user" | "admin",
                        })
                      }
                      className="rounded-md border border-gray-300 bg-white px-3 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                    >
                      <option value="user">User</option>
                      <option value="admin">Admin</option>
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
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

export default function MainPage() {
  // 상태 토글/전설 UI 제거
  const [bookings, setBookings] = useState<BookingsByDate>({});
  const [selectedDate, setSelectedDate] = useState(new Date());
  const [selectedBooking, setSelectedBooking] = useState<Booking | null>(null);
  const [activeMonth, setActiveMonth] = useState(new Date());
  const [isNewBookingModalOpen, setIsNewBookingModalOpen] = useState(false);
  const [isAccountModalOpen, setIsAccountModalOpen] = useState(false);
  const logout = useAuthStore((state) => state.logout);
  const [tooltip, setTooltip] = useState<{
    content: string;
    x: number;
    y: number;
  } | null>(null);

  const showToast = (
    message: string,
    type: "success" | "error" | "info" = "info"
  ) => {
    const div = document.createElement("div");
    div.className =
      `fixed bottom-6 left-1/2 -translate-x-1/2 z-[9999] px-4 py-3 rounded-lg shadow-lg text-sm pointer-events-none ` +
      (type === "success"
        ? "bg-green-500 text-white"
        : type === "error"
        ? "bg-red-500 text-white"
        : "bg-gray-800 text-white");
    div.textContent = message;
    document.body.appendChild(div);
    requestAnimationFrame(() => {
      div.style.opacity = "1";
      div.style.transition = "opacity 0.3s ease";
    });
    setTimeout(() => {
      div.style.opacity = "0";
      setTimeout(() => {
        if (div.parentNode) document.body.removeChild(div);
      }, 300);
    }, 1800);
  };

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
      const response = await axios.get<BookingsByDate>(
        `${API_BASE_URL}/api/bookings`
      );
      if (user?.role === 'admin') {
        setBookings(response.data);
      } else {
        const filteredBookings: BookingsByDate = {};
        for (const date in response.data) {
          const dayBookings = response.data[date].filter(
            (b) => b.account === user?.name
          );
          if (dayBookings.length > 0) {
            filteredBookings[date] = dayBookings;
          }
        }
        setBookings(filteredBookings);
      }
    } catch (error) {
      console.error("Failed to fetch bookings:", error);
      if (axios.isAxiosError(error) && error.response?.status === 401) {
        showToast("세션이 만료되었습니다. 다시 로그인해주세요.", "error");
        logout();
      }
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
      await axios.put(
        `${API_BASE_URL}/api/bookings/${moment(selectedDate).format(
          "YYYYMMDD"
        )}/${selectedBooking.account}`,
        updatedBooking
      );

      fetchBookings();
      showToast("예약이 변경되었습니다.", "success");
      setIsNewBookingModalOpen(false);
      setSelectedBooking(null);
    } catch (error) {
      console.error("Error updating booking:", error);
      if (axios.isAxiosError(error)) {
        if (error.response?.status === 401) {
          showToast("세션이 만료되었습니다. 다시 로그인해주세요.", "error");
          logout();
        } else {
          const message =
            (error.response?.data as { message?: string } | undefined)
              ?.message || "예약 변경에 실패했습니다.";
          showToast(message, "error");
        }
      } else {
        showToast("예약 변경에 실패했습니다.", "error");
      }
    }
  };

  const handleDeleteBooking = async () => {
    if (!selectedBooking || !selectedDate) return;

    try {
      await axios.delete(
        `${API_BASE_URL}/api/bookings/${moment(selectedDate).format(
          "YYYYMMDD"
        )}/${selectedBooking.account}`
      );

      // Refresh bookings and close modal
      fetchBookings();
      showToast("예약이 삭제되었습니다.", "success");
      setIsNewBookingModalOpen(false);
      setSelectedBooking(null);
    } catch (error) {
      console.error("Error deleting booking:", error);
      if (axios.isAxiosError(error)) {
        if (error.response?.status === 401) {
          showToast("세션이 만료되었습니다. 다시 로그인해주세요.", "error");
          logout();
        } else {
          const message =
            (error.response?.data as { message?: string } | undefined)
              ?.message || "예약 삭제에 실패했습니다.";
          showToast(message, "error");
        }
      } else {
        showToast("예약 삭제에 실패했습니다.", "error");
      }
    }
  };

  const user = useAuthStore((state) => state.user);

  const getTileContent = ({ date, view }: { date: Date; view: string }) => {
    if (view !== "month") return null;
    const dateStr = moment(date).format("YYYYMMDD");
    const dayBookings = bookings[dateStr] || [];

    const getTooltipText = (booking: Booking) => {
      const timeRange = `${booking.startTime} - ${booking.endTime}`;
      const statusText = booking.status === "접수" ? "접수중" : booking.status;
      if (user?.role === 'admin') {
        return `${booking.account} ${timeRange} ${statusText}`;
      }
      return `${timeRange} ${statusText}`;
    };

    return (
      <div className="flex flex-col items-stretch text-xs mt-1 space-y-1 p-1 h-full">
        {dayBookings.map((booking, index) => (
          <div
            key={index}
            onClick={(e) => {
              e.stopPropagation();
              handleBookingClick(booking, date);
            }}
            onMouseEnter={(e) => {
              setTooltip({
                content: getTooltipText(booking),
                x: e.clientX,
                y: e.clientY,
              });
            }}
            onMouseLeave={() => setTooltip(null)}
            onMouseMove={(e) => {
              if (tooltip) {
                setTooltip((prev) =>
                  prev ? { ...prev, x: e.clientX, y: e.clientY } : prev
                );
              }
            }}
            className={`w-full text-white rounded-md text-center text-[10px] leading-tight py-1 cursor-pointer ${getStatusColor(
              booking.status
            )}`}
          >
            {user?.role === 'admin' ? booking.account : booking.startTime}
          </div>
        ))}
      </div>
    );
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-200 via-gray-100 to-blue-200 text-gray-900 font-sans">
      <div className="container mx-auto p-4 sm:p-6 lg:p-8 max-w-7xl">
        <header className="relative flex justify-end items-center mb-10">
          <div className="flex gap-2">
            <button
              onClick={() => setIsAccountModalOpen(true)}
              className="p-2 rounded-full bg-white/80 hover:bg-blue-100 border border-blue-100 shadow-sm"
            >
              <User className="h-6 w-6 text-gray-600" />
            </button>
            <button
              onClick={logout}
              className="p-2 rounded-full bg-white/80 hover:bg-red-100 border border-red-100 shadow-sm"
            >
              <LogOut className="h-6 w-6 text-red-600" />
            </button>
          </div>
        </header>

        <main>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
            <div className="bg-white/90 backdrop-blur-sm p-4 sm:p-6 rounded-2xl shadow-xl border border-blue-100">
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
            <div className="bg-white/90 backdrop-blur-sm p-4 sm:p-6 rounded-2xl shadow-xl border border-blue-100">
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

      {tooltip && (
        <div
          className="fixed z-[9999] px-3 py-1.5 bg-gray-800 text-white text-xs rounded-md shadow-lg pointer-events-none whitespace-nowrap"
          style={{ top: tooltip.y + 15, left: tooltip.x + 15 }}
        >
          {tooltip.content}
        </div>
      )}

      <AccountManager
        isOpen={isAccountModalOpen}
        onClose={() => setIsAccountModalOpen(false)}
      />
    </div>
  );
}
