import { useState, useEffect, useRef } from "react";
import Calendar from "react-calendar";
import moment from "moment";
import { User, LogOut, MessageCircle, ChevronLeft, Menu } from "lucide-react";
import useAuthStore from "@/store/authStore";
import { API_BASE_URL } from "../config";
import NewBookingForm from "../NewBookingForm";
import axios from "axios";

interface ManagedUser {
  id: string;
  name: string;
  granted: boolean;
  role: "user" | "admin";
  debeachLoginId: string;
  hasDebeachPassword: boolean;
  passwordRequestHistory?: PasswordChangeRequestItem[];
}

interface PasswordChangeRequestItem {
  id: string;
  requesterName: string;
  requestType?: "app_password" | "debeach_password";
  status: "pending" | "approved" | "rejected";
  createdAt: string;
  rejectReason?: string;
  reviewedAt?: string | null;
  reviewedBy?: string;
}

interface Booking {
  account: string;
  status: "예약" | "접수" | "재시도" | "성공" | "실패";
  successTime?: string | null;
  bookedSlot?: { bk_time: string; bk_cours: string } | null;
  startTime: string;
  endTime: string;
  memo?: string | null;
  createdByName?: string | null;
  createdByRole?: string | null;
  teeTotal?: number | null;
  teeFirstHalf?: number | null;
  teeSecondHalf?: number | null;
  teeInRange?: number | null;
}

interface MessageContact {
  name: string;
  granted: boolean;
  unreadCount?: number;
}

interface ChatMessage {
  id: string;
  roomKey: string;
  senderName: string;
  adminUsername: string;
  userUsername: string;
  senderUsername: string;
  senderRole: "user" | "admin";
  body: string;
  readBy?: string[];
  bookingContext?: {
    account?: string;
    date?: string;
    startTime?: string;
    endTime?: string;
    memo?: string;
    status?: string;
    bookedTime?: string;
  } | null;
  createdAt: string;
}

type BookingsByDate = Record<string, Booking[]>;

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
  const [profileForm, setProfileForm] = useState({
    name: user?.name ?? "",
    debeachLoginId: user?.debeachLoginId ?? "",
  });
  const [passwordForm, setPasswordForm] = useState({
    appNewPassword: "",
    debeachNewPassword: "",
  });
  const [showAppPasswordRequestInput, setShowAppPasswordRequestInput] =
    useState(false);
  const [showDebeachPasswordRequestInput, setShowDebeachPasswordRequestInput] =
    useState(false);
  const [passwordRequests, setPasswordRequests] = useState<
    PasswordChangeRequestItem[]
  >([]);
  const [saving, setSaving] = useState(false);
  const showToast = (
    message: string,
    type: "success" | "error" | "info" = "info",
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
  const fetchUsers = async () => {
    if (user?.role !== "admin") return;
    try {
      const response = await axios.get(`${API_BASE_URL}/api/users`);
      setUsers(response.data);
    } catch (error) {
      console.error("Failed to fetch users:", error);
    }
  };

  const fetchPasswordRequests = async () => {
    if (user?.role !== "admin") return;
    try {
      const response = await axios.get(
        `${API_BASE_URL}/api/password-change-requests`,
      );
      setPasswordRequests(response.data);
    } catch (error) {
      console.error("Failed to fetch password requests:", error);
    }
  };

  useEffect(() => {
    if (isOpen && user?.role === "admin") {
      fetchUsers();
      fetchPasswordRequests();
    }
  }, [isOpen, user?.role]);

  useEffect(() => {
    if (isOpen) {
      setProfileForm({
        name: user?.name ?? "",
        debeachLoginId: user?.debeachLoginId ?? "",
      });
      setPasswordForm({ appNewPassword: "", debeachNewPassword: "" });
      setShowAppPasswordRequestInput(false);
      setShowDebeachPasswordRequestInput(false);
    }
  }, [isOpen, user?.debeachLoginId, user?.name]);

  const handleUserUpdate = async (
    userId: string,
    data: Partial<ManagedUser>,
  ) => {
    try {
      await axios.put(`${API_BASE_URL}/api/users/${userId}`, data);
      setUsers((prev) =>
        prev.map((item) => (item.id === userId ? { ...item, ...data } : item)),
      );
    } catch (error) {
      console.error("Failed to update user:", error);
    }
  };

  const handleAppPasswordRequest = async () => {
    if (!passwordForm.appNewPassword) return;
    try {
      setSaving(true);
      const response = await axios.put(`${API_BASE_URL}/api/profile/password`, {
        newPassword: passwordForm.appNewPassword,
      });
      setPasswordForm((prev) => ({ ...prev, appNewPassword: "" }));
      setShowAppPasswordRequestInput(false);
      showToast(
        response.data.message || "비밀번호 변경 요청을 보냈습니다.",
        "success",
      );
    } catch (error) {
      console.error("Failed to change app password:", error);
      showToast("비밀번호 변경 요청에 실패했습니다.", "error");
    } finally {
      setSaving(false);
    }
  };

  const handleDebeachPasswordRequest = async () => {
    if (!passwordForm.debeachNewPassword) return;
    try {
      setSaving(true);
      const response = await axios.put(
        `${API_BASE_URL}/api/profile/debeach-password`,
        { newPassword: passwordForm.debeachNewPassword },
      );
      setPasswordForm((prev) => ({ ...prev, debeachNewPassword: "" }));
      setShowDebeachPasswordRequestInput(false);
      showToast(
        response.data.message || "드비치 비밀번호 변경 요청을 보냈습니다.",
        "success",
      );
    } catch (error) {
      console.error("Failed to change Debeach password:", error);
      showToast("드비치 비밀번호 변경 요청에 실패했습니다.", "error");
    } finally {
      setSaving(false);
    }
  };

  const handleCloseProfile = async () => {
    if (user?.role === "admin") {
      onClose();
      return;
    }

    try {
      setSaving(true);
      const response = await axios.put(
        `${API_BASE_URL}/api/profile`,
        profileForm,
      );
      setUser(response.data.user);
      onClose();
    } catch (error) {
      console.error("Failed to save profile on close:", error);
      showToast("내 정보 저장에 실패했습니다.", "error");
    } finally {
      setSaving(false);
    }
  };

  const handlePasswordRequestAction = async (
    requestId: string,
    action: "approve" | "reject",
  ) => {
    try {
      setSaving(true);
      await axios.post(
        `${API_BASE_URL}/api/password-change-requests/${requestId}/${action}`,
        {},
      );
      await fetchPasswordRequests();
      await fetchUsers();
    } catch (error) {
      console.error(`Failed to ${action} password request:`, error);
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteUser = async (managedUser: ManagedUser) => {
    try {
      setSaving(true);
      await axios.delete(`${API_BASE_URL}/api/users/${managedUser.id}`);
      setUsers((prev) => prev.filter((item) => item.id !== managedUser.id));
      showToast(`${managedUser.name} 계정을 삭제했습니다.`, "success");
    } catch (error) {
      console.error("Failed to delete user:", error);
      showToast("계정 삭제에 실패했습니다.", "error");
    } finally {
      setSaving(false);
    }
  };

  if (!isOpen) return null;

  if (user?.role !== "admin") {
    return (
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
        onClick={onClose}
      >
        <div
          className="w-full max-w-md rounded-3xl bg-white p-6 shadow-2xl"
          onClick={(e) => e.stopPropagation()}
        >
          <h2 className="mb-5 text-2xl font-bold text-gray-900">내 정보</h2>
          <div className="space-y-4">
            <div className="space-y-2">
              <label className="text-sm font-medium text-gray-700">이름</label>
              <input
                type="text"
                value={profileForm.name}
                onChange={(e) =>
                  setProfileForm((prev) => ({ ...prev, name: e.target.value }))
                }
                className="w-full rounded-xl border border-gray-300 px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium text-gray-700">
                드비치 아이디
              </label>
              <input
                type="text"
                value={profileForm.debeachLoginId}
                onChange={(e) =>
                  setProfileForm((prev) => ({
                    ...prev,
                    debeachLoginId: e.target.value,
                  }))
                }
                className="w-full rounded-xl border border-gray-300 px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium text-gray-700">
                비밀번호 변경 요청
              </label>
              <button
                type="button"
                onClick={() => {
                  if (!showAppPasswordRequestInput) {
                    setShowAppPasswordRequestInput(true);
                    return;
                  }
                  void handleAppPasswordRequest();
                }}
                disabled={saving}
                className="rounded-xl bg-gray-700 px-4 py-2 text-sm text-white hover:bg-gray-800 disabled:opacity-60"
              >
                비밀번호
              </button>
              {showAppPasswordRequestInput && (
                <input
                  type="password"
                  placeholder="새 비밀번호"
                  value={passwordForm.appNewPassword}
                  onChange={(e) =>
                    setPasswordForm((prev) => ({
                      ...prev,
                      appNewPassword: e.target.value,
                    }))
                  }
                  className="w-full rounded-xl border border-gray-300 px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              )}
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium text-gray-700">
                드비치 비밀번호 변경 요청
              </label>
              <button
                type="button"
                onClick={() => {
                  if (!showDebeachPasswordRequestInput) {
                    setShowDebeachPasswordRequestInput(true);
                    return;
                  }
                  void handleDebeachPasswordRequest();
                }}
                disabled={saving}
                className="rounded-xl bg-gray-700 px-4 py-2 text-sm text-white hover:bg-gray-800 disabled:opacity-60"
              >
                드비치 비밀번호
              </button>
              {showDebeachPasswordRequestInput && (
                <input
                  type="password"
                  placeholder="새 드비치 비밀번호"
                  value={passwordForm.debeachNewPassword}
                  onChange={(e) =>
                    setPasswordForm((prev) => ({
                      ...prev,
                      debeachNewPassword: e.target.value,
                    }))
                  }
                  className="w-full rounded-xl border border-gray-300 px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              )}
            </div>
          </div>
          <div className="mt-6 flex flex-wrap justify-end gap-2">
            <button
              type="button"
              onClick={() => void handleCloseProfile()}
              disabled={saving}
              className="rounded-xl bg-gray-100 px-4 py-2 text-sm text-gray-700 hover:bg-gray-200"
            >
              닫기
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-5xl rounded-[2rem] border border-stone-200 bg-stone-50/95 p-8 shadow-[0_24px_80px_rgba(28,25,23,0.14)] backdrop-blur-sm"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-5 flex items-center justify-between">
          <h2 className="text-2xl font-semibold tracking-tight text-stone-800">
            사용자 관리
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full border border-stone-200 bg-white px-4 py-2 text-sm text-stone-600 transition-colors hover:bg-stone-100"
          >
            닫기
          </button>
        </div>
        <div className="mb-5 flex flex-wrap gap-2 text-sm">
          <span className="rounded-full border border-stone-200 bg-white px-3 py-1 text-stone-700">
            전체 {users.length}명
          </span>
          <span className="rounded-full border border-stone-200 bg-stone-100 px-3 py-1 text-stone-600">
            승인 대기 {users.filter((item) => !item.granted).length}명
          </span>
          <span className="rounded-full border border-stone-200 bg-[#f3f1eb] px-3 py-1 text-stone-700">
            승인 완료 {users.filter((item) => item.granted).length}명
          </span>
        </div>
        <div className="overflow-x-auto rounded-[1.5rem] border border-stone-200 bg-white/80">
          <table className="min-w-full divide-y divide-stone-200">
            <thead className="bg-stone-100/80">
              <tr>
                <th className="px-5 py-3 text-left text-sm font-semibold text-stone-500">
                  이름
                </th>
                <th className="px-5 py-3 text-left text-sm font-semibold text-stone-500">
                  드비치 아이디
                </th>
                <th className="px-5 py-3 text-left text-sm font-semibold text-stone-500">
                  회원 승인
                </th>
                <th className="px-5 py-3 text-left text-sm font-semibold text-stone-500">
                  삭제
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-100">
              {users.map((managedUser) => {
                const appPasswordRequest = passwordRequests.find(
                  (request) =>
                    request.requesterName === managedUser.name &&
                    request.requestType === "app_password" &&
                    request.status === "pending",
                );
                const debeachPasswordRequest = passwordRequests.find(
                  (request) =>
                    request.requesterName === managedUser.name &&
                    request.requestType === "debeach_password" &&
                    request.status === "pending",
                );

                return (
                  <tr key={managedUser.id}>
                    <td className="px-5 py-4 text-sm text-stone-700">
                      <div className="flex items-center justify-between gap-3">
                        <span className="font-medium text-stone-800">
                          {managedUser.name}
                        </span>
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-stone-400">
                            비밀번호
                          </span>
                          <button
                            type="button"
                            disabled={saving || !appPasswordRequest}
                            onClick={() =>
                              appPasswordRequest &&
                              void handlePasswordRequestAction(
                                appPasswordRequest.id,
                                "approve",
                              )
                            }
                            className="rounded-full border border-stone-200 bg-stone-200 px-3 py-1 text-xs font-medium text-stone-700 transition-colors hover:bg-stone-300 disabled:opacity-30"
                          >
                            승인
                          </button>
                          <button
                            type="button"
                            disabled={saving || !appPasswordRequest}
                            onClick={() =>
                              appPasswordRequest &&
                              void handlePasswordRequestAction(
                                appPasswordRequest.id,
                                "reject",
                              )
                            }
                            className="rounded-full border border-stone-200 bg-white px-3 py-1 text-xs font-medium text-stone-500 transition-colors hover:bg-stone-100 disabled:opacity-30"
                          >
                            반려
                          </button>
                        </div>
                      </div>
                    </td>
                    <td className="px-5 py-4 text-sm text-stone-700">
                      <div className="flex items-center justify-between gap-3">
                        <span>{managedUser.debeachLoginId}</span>
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-stone-400">
                            드비치 비밀번호
                          </span>
                          <button
                            type="button"
                            disabled={saving || !debeachPasswordRequest}
                            onClick={() =>
                              debeachPasswordRequest &&
                              void handlePasswordRequestAction(
                                debeachPasswordRequest.id,
                                "approve",
                              )
                            }
                            className="rounded-full border border-stone-200 bg-stone-200 px-3 py-1 text-xs font-medium text-stone-700 transition-colors hover:bg-stone-300 disabled:opacity-30"
                          >
                            승인
                          </button>
                          <button
                            type="button"
                            disabled={saving || !debeachPasswordRequest}
                            onClick={() =>
                              debeachPasswordRequest &&
                              void handlePasswordRequestAction(
                                debeachPasswordRequest.id,
                                "reject",
                              )
                            }
                            className="rounded-full border border-stone-200 bg-white px-3 py-1 text-xs font-medium text-stone-500 transition-colors hover:bg-stone-100 disabled:opacity-30"
                          >
                            반려
                          </button>
                        </div>
                      </div>
                    </td>
                    <td className="px-5 py-4 text-sm text-stone-700">
                      <input
                        type="checkbox"
                        checked={managedUser.granted}
                        onChange={(event) =>
                          handleUserUpdate(managedUser.id, {
                            granted: event.target.checked,
                          })
                        }
                        className="h-4 w-4 rounded border-stone-300 text-stone-600 focus:ring-stone-400"
                      />
                    </td>
                    <td className="px-5 py-4 text-sm text-stone-700">
                      <button
                        type="button"
                        disabled={saving}
                        onClick={() => void handleDeleteUser(managedUser)}
                        className="rounded-full border border-stone-200 bg-stone-100 px-3 py-2 text-sm text-stone-600 transition-colors hover:bg-stone-200 disabled:opacity-40"
                      >
                        삭제
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};

export default function MainPage() {
  // 상태 토글/전설 UI 제거
  const user = useAuthStore((state) => state.user);
  const logout = useAuthStore((state) => state.logout);
  const [bookings, setBookings] = useState<BookingsByDate>({});
  const [selectedDate, setSelectedDate] = useState(new Date());
  const [selectedBooking, setSelectedBooking] = useState<Booking | null>(null);
  const [activeMonth, setActiveMonth] = useState(new Date());
  const [isNewBookingModalOpen, setIsNewBookingModalOpen] = useState(false);
  const [isAccountModalOpen, setIsAccountModalOpen] = useState(false);
  const [isHistoryModalOpen, setIsHistoryModalOpen] = useState(false);
  const [isChatOpen, setIsChatOpen] = useState(false);
  const [isFabOpen, setIsFabOpen] = useState(false);
  const [isMobileContactListOpen, setIsMobileContactListOpen] = useState(false);
  const [contacts, setContacts] = useState<MessageContact[]>([]);
  const [selectedChatUsername, setSelectedChatUsername] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [messageBody, setMessageBody] = useState("");
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [sendingMessage, setSendingMessage] = useState(false);
  const sendingMessageRef = useRef(false);
  const fabRef = useRef<HTMLDivElement | null>(null);
  const chatWindowRef = useRef<HTMLDivElement | null>(null);
  const chatScrollRef = useRef<HTMLDivElement | null>(null);
  const chatInputRef = useRef<HTMLTextAreaElement | null>(null);
  const previousUnreadCountRef = useRef(0);
  const latestMessageSignatureRef = useRef("");
  const [tooltip, setTooltip] = useState<{
    content: string;
    x: number;
    y: number;
  } | null>(null);

  const showToast = (
    message: string,
    type: "success" | "error" | "info" = "info",
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

  const statusRingLegend: Record<Booking["status"], string> = {
    성공: "ring-green-500",
    실패: "ring-red-500",
    예약: "ring-blue-500",
    접수: "ring-yellow-500",
    재시도: "ring-gray-400",
  };

  const getStatusColor = (status: Booking["status"]) => {
    return statusLegend[status] || "bg-gray-400";
  };

  const getStatusRingColor = (status: Booking["status"]) => {
    return statusRingLegend[status] || "ring-gray-400";
  };

  const totalUnreadCount = contacts.reduce(
    (sum, contact) => sum + (contact.unreadCount || 0),
    0,
  );

  const fetchBookings = async () => {
    try {
      const response = await axios.get<BookingsByDate>(
        `${API_BASE_URL}/api/bookings`,
      );
      setBookings(response.data);
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

    // WebSocket connection for real-time Lambda results
    const wsProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${wsProtocol}//${window.location.hostname}:8081`;
    const ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      console.log("WebSocket connected for real-time booking updates");
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        console.log("Received WebSocket message:", data);

        if (
          data.type === "booking_success" ||
          data.type === "booking_failure" ||
          data.type === "booking_error"
        ) {
          // Update bookings state directly without API call
          const dateStr = data.date;
          const status = data.type === "booking_success" ? "성공" : "실패";

          setBookings((prev) => {
            const updated = { ...prev };
            if (!updated[dateStr]) updated[dateStr] = [];

            const bookingIndex = updated[dateStr].findIndex(
              (b) => b.account === data.account,
            );
            if (bookingIndex >= 0) {
              updated[dateStr][bookingIndex] = {
                ...updated[dateStr][bookingIndex],
                status,
                bookedSlot:
                  data.slot || updated[dateStr][bookingIndex].bookedSlot,
                teeTotal: data.stats?.teeTotal,
                teeFirstHalf: data.stats?.teeFirstHalf,
                teeSecondHalf: data.stats?.teeSecondHalf,
                teeInRange: data.stats?.teeInRange,
              };
            }
            return updated;
          });

          // Show toast notification
          if (data.type === "booking_success") {
            showToast(
              `${data.account} 예약 성공! (${data.slot?.bk_time || "시간 미상"})`,
              "success",
            );
          } else {
            showToast(
              `${data.account} 예약 실패: ${data.reason || "알 수 없는 오류"}`,
              "error",
            );
          }
        }
      } catch (error) {
        console.error("Failed to parse WebSocket message:", error);
      }
    };

    ws.onerror = (error) => {
      console.error("WebSocket error:", error);
    };

    ws.onclose = () => {
      console.log("WebSocket disconnected");
    };

    return () => {
      ws.close();
    };
  }, []);

  const fetchContacts = async () => {
    try {
      const response = await axios.get<MessageContact[]>(
        `${API_BASE_URL}/api/messages/contacts`,
      );
      setContacts(response.data);
      if (!selectedChatUsername && response.data.length > 0) {
        setSelectedChatUsername(response.data[0].name);
      }
    } catch (error) {
      console.error("Failed to fetch message contacts:", error);
    }
  };

  const fetchMessages = async (
    otherUsername: string,
    options?: { silent?: boolean },
  ) => {
    if (!otherUsername) return;
    try {
      if (!options?.silent) {
        setMessagesLoading(true);
      }
      const response = await axios.get<ChatMessage[]>(
        `${API_BASE_URL}/api/messages`,
        {
          params: { with: otherUsername },
        },
      );
      const dedupedMessages = Array.from(
        new Map(response.data.map((message) => [message.id, message])).values(),
      );
      setMessages(dedupedMessages);
      setContacts((prev) =>
        prev.map((contact) =>
          contact.name === otherUsername
            ? { ...contact, unreadCount: 0 }
            : contact,
        ),
      );
      void fetchContacts();
    } catch (error) {
      console.error("Failed to fetch messages:", error);
    } finally {
      if (!options?.silent) {
        setMessagesLoading(false);
      }
    }
  };

  useEffect(() => {
    fetchContacts();
  }, []);

  useEffect(() => {
    if (selectedChatUsername) {
      fetchMessages(selectedChatUsername);
    }
  }, [selectedChatUsername]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      fetchContacts();
      if (selectedChatUsername) {
        fetchMessages(selectedChatUsername, { silent: true });
      }
    }, 10000);
    return () => window.clearInterval(interval);
  }, [selectedChatUsername]);

  useEffect(() => {
    const handlePointerDown = (event: MouseEvent) => {
      if (!fabRef.current) return;
      if (!fabRef.current.contains(event.target as Node)) {
        setIsFabOpen(false);
      }
    };
    if (isFabOpen) {
      document.addEventListener("mousedown", handlePointerDown);
    }
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
    };
  }, [isFabOpen]);

  useEffect(() => {
    const handlePointerDown = (event: MouseEvent) => {
      if (!isChatOpen || !chatWindowRef.current) return;
      if (chatWindowRef.current.contains(event.target as Node)) return;
      setIsChatOpen(false);
      setIsMobileContactListOpen(false);
    };
    if (isChatOpen) {
      document.addEventListener("mousedown", handlePointerDown);
    }
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
    };
  }, [isChatOpen]);

  useEffect(() => {
    if (!isChatOpen) return;
    const frame = window.requestAnimationFrame(() => {
      if (chatScrollRef.current) {
        chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight;
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [isChatOpen, messages, messagesLoading, selectedChatUsername]);

  useEffect(() => {
    if (!isChatOpen || !selectedChatUsername) return;
    const frame = window.requestAnimationFrame(() => {
      chatInputRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [isChatOpen, selectedChatUsername]);

  useEffect(() => {
    if (isChatOpen) {
      setIsMobileContactListOpen(false);
    }
  }, [isChatOpen, selectedChatUsername]);

  useEffect(() => {
    const newestMessage = messages[messages.length - 1];
    const nextSignature = newestMessage
      ? `${newestMessage.id}:${newestMessage.readBy?.join(",") || ""}`
      : "";

    if (
      newestMessage &&
      latestMessageSignatureRef.current &&
      newestMessage.senderUsername !== user?.name &&
      !(isChatOpen && selectedChatUsername === newestMessage.senderUsername) &&
      nextSignature !== latestMessageSignatureRef.current
    ) {
      showToast(`${newestMessage.senderUsername} 님의 새 메시지`, "info");
      try {
        const audioContext = new window.AudioContext();
        const oscillator = audioContext.createOscillator();
        const gainNode = audioContext.createGain();
        oscillator.connect(gainNode);
        gainNode.connect(audioContext.destination);
        oscillator.type = "sine";
        oscillator.frequency.setValueAtTime(880, audioContext.currentTime);
        gainNode.gain.setValueAtTime(0.0001, audioContext.currentTime);
        gainNode.gain.exponentialRampToValueAtTime(
          0.08,
          audioContext.currentTime + 0.01,
        );
        gainNode.gain.exponentialRampToValueAtTime(
          0.0001,
          audioContext.currentTime + 0.18,
        );
        oscillator.start();
        oscillator.stop(audioContext.currentTime + 0.18);
        oscillator.onended = () => {
          void audioContext.close();
        };
      } catch (error) {
        console.warn("Failed to play message notification sound:", error);
      }
    }

    latestMessageSignatureRef.current = nextSignature;
  }, [messages, user?.name, isChatOpen, selectedChatUsername]);

  useEffect(() => {
    if (
      totalUnreadCount > previousUnreadCountRef.current &&
      !(isChatOpen && selectedChatUsername)
    ) {
      showToast(`읽지 않은 메시지 ${totalUnreadCount}개`, "info");
    }
    previousUnreadCountRef.current = totalUnreadCount;
  }, [totalUnreadCount, isChatOpen, selectedChatUsername]);

  useEffect(() => {
    const baseTitle = "Golf-book";
    document.title =
      totalUnreadCount > 0 ? `(${totalUnreadCount}) ${baseTitle}` : baseTitle;
    return () => {
      document.title = baseTitle;
    };
  }, [totalUnreadCount]);

  const sendMessage = async (options?: {
    body?: string;
    bookingContext?: ChatMessage["bookingContext"];
  }) => {
    if (!selectedChatUsername) return;
    if (sendingMessageRef.current) return;
    const nextBody = (options?.body ?? messageBody).trim();
    if (!nextBody) return;

    try {
      sendingMessageRef.current = true;
      setSendingMessage(true);
      const response = await axios.post(`${API_BASE_URL}/api/messages`, {
        toUsername: selectedChatUsername,
        body: nextBody,
        bookingContext: options?.bookingContext,
      });
      const nextMessage = response.data.message as ChatMessage;
      setMessages((prev) => {
        const merged = [...prev, nextMessage];
        return Array.from(
          new Map(merged.map((message) => [message.id, message])).values(),
        );
      });
      setMessageBody("");
      void fetchMessages(selectedChatUsername, { silent: true });
      void fetchContacts();
    } catch (error) {
      console.error("Failed to send message:", error);
      showToast("메시지 전송에 실패했습니다.", "error");
    } finally {
      sendingMessageRef.current = false;
      setSendingMessage(false);
    }
  };

  const handleChatInputKeyDown = (
    event: React.KeyboardEvent<HTMLTextAreaElement>,
  ) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void sendMessage();
    }
  };

  const handleDayClick = (date: Date) => {
    setSelectedDate(date);
    setIsNewBookingModalOpen(true);
  };

  const handleBookingClick = (booking: Booking, date: Date) => {
    setSelectedDate(date);
    setSelectedBooking(booking);
    if (booking.status === "성공" || booking.status === "실패") {
      // 예약 시도가 완료된 경우(성공/실패)는 항상 예약 내역 모달을 표시
      setIsHistoryModalOpen(true);
      setIsNewBookingModalOpen(false);
    } else {
      // 아직 진행 중(예약/접수/재시도)인 경우에만 예약 변경/신규 폼을 표시
      setIsNewBookingModalOpen(true);
      setIsHistoryModalOpen(false);
    }
  };

  const handleUpdateBooking = async (updatedBooking: {
    startTime: string;
    endTime: string;
    memo?: string;
  }) => {
    if (!selectedBooking || !selectedDate) return;

    try {
      await axios.put(
        `${API_BASE_URL}/api/bookings/${moment(selectedDate).format(
          "YYYYMMDD",
        )}/${selectedBooking.account}`,
        updatedBooking,
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
          "YYYYMMDD",
        )}/${selectedBooking.account}`,
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

  // Wait for WebSocket push only (no polling)
  const waitForBookingResult = async (
    account: string,
    dateStr: string,
    timeoutMs = 60_000,
  ): Promise<"성공" | "실패"> => {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      const booking = bookings[dateStr]?.find((b) => b.account === account);
      if (booking && (booking.status === "성공" || booking.status === "실패")) {
        return booking.status;
      }
      // Wait 100ms before checking again (WebSocket will update bookings state)
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    throw new Error("결과 확인 시간 초과");
  };

  const handleRetryBookingImmediately = async () => {
    if (!selectedBooking || !selectedDate) return;

    showToast("즉시 재시도 요청 중...", "info");

    try {
      const dateStr = moment(selectedDate).format("YYYYMMDD");

      const res = await axios.post(`${API_BASE_URL}/api/submit-booking`, {
        account: selectedBooking.account,
        date: dateStr,
        startTime: selectedBooking.startTime,
        endTime: selectedBooking.endTime,
        force: true,
      });

      const message =
        (res.data as { message?: string } | undefined)?.message ||
        "재시도 요청이 접수되었습니다.";
      const isQueued = message.includes("큐");
      showToast(message, isQueued ? "info" : "success");

      fetchBookings();
      setIsHistoryModalOpen(false);

      const shouldPoll = !isQueued && message.includes("즉시");
      if (shouldPoll) {
        try {
          const status = await waitForBookingResult(
            selectedBooking.account,
            dateStr,
          );
          if (status === "성공") {
            showToast("재시도 결과: 성공", "success");
          } else {
            showToast("재시도 결과: 실패", "error");
          }
        } catch (e) {
          if (e instanceof Error) {
            showToast(`재시도 결과 확인 실패: ${e.message}`, "error");
          } else {
            showToast("재시도 결과 확인 실패", "error");
          }
        }
      }
    } catch (error) {
      console.error("Error retrying booking:", error);
      if (axios.isAxiosError(error) && error.response?.status === 401) {
        showToast("세션이 만료되었습니다. 다시 로그인해주세요.", "error");
        logout();
        return;
      }
      const message =
        (axios.isAxiosError(error)
          ? (error.response?.data as { message?: string } | undefined)?.message
          : undefined) || "즉시 재시도에 실패했습니다.";
      showToast(message, "error");
    }
  };

  const createTileContent = (monthAnchor: Date) => {
    const gridStart = moment(monthAnchor).startOf("month").startOf("week");
    const gridEnd = moment(monthAnchor).endOf("month").endOf("week");
    const weekMaxBookingCounts = new Map<number, number>();

    const cursor = gridStart.clone();
    while (cursor.isSameOrBefore(gridEnd, "day")) {
      const dateStr = cursor.format("YYYYMMDD");
      const bookingCount = bookings[dateStr]?.length || 0;
      const weekIndex = Math.floor(cursor.diff(gridStart, "days") / 7);
      const currentMax = weekMaxBookingCounts.get(weekIndex) || 0;
      weekMaxBookingCounts.set(weekIndex, Math.max(currentMax, bookingCount));
      cursor.add(1, "day");
    }

    return ({ date, view }: { date: Date; view: string }) => {
      if (view !== "month") return null;
      const dateStr = moment(date).format("YYYYMMDD");
      const dayBookings = bookings[dateStr] || [];
      const weekIndex = Math.floor(
        moment(date).startOf("day").diff(gridStart, "days") / 7,
      );
      const weekMaxBookingCount =
        weekMaxBookingCounts.get(weekIndex) ?? dayBookings.length;

      const getTileHeight = (bookingCount: number) =>
        `${Math.max(34, bookingCount * 26 + 28)}px`;

      const isAdminCreatedBooking = (booking: Booking) =>
        booking.createdByRole === "admin";

      const getTooltipText = (booking: Booking) => {
        const requestedRange = `${booking.startTime} - ${booking.endTime}`;
        const bookedTime =
          booking.bookedSlot?.bk_time || booking.successTime || null;
        const timeText =
          booking.status === "성공" && bookedTime ? bookedTime : requestedRange;
        const statusText =
          booking.status === "접수" ? "접수중" : booking.status;
        if (user?.role === "admin") {
          return `${booking.account} ${timeText} ${statusText}`;
        }
        return `${timeText} ${statusText}`;
      };

      return (
        <div
          className="mt-0.5 flex flex-col items-stretch gap-1 px-0.5 pb-1 text-xs"
          style={{ height: getTileHeight(weekMaxBookingCount) }}
        >
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
                    prev ? { ...prev, x: e.clientX, y: e.clientY } : prev,
                  );
                }
              }}
              className={`w-full rounded-md py-1.5 text-center text-[10px] leading-tight text-white cursor-pointer ${getStatusColor(
                booking.status,
              )} ${
                isAdminCreatedBooking(booking)
                  ? `ring-2 ring-offset-1 ring-offset-white ${getStatusRingColor(
                      booking.status,
                    )}`
                  : ""
              }`}
            >
              {user?.role === "admin" ? booking.account : booking.startTime}
            </div>
          ))}
        </div>
      );
    };
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-200 via-gray-100 to-blue-200 text-gray-900 font-sans">
      <div className="container mx-auto p-4 sm:p-6 lg:p-8 max-w-[1600px]">
        <main>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
            <div className="bg-white/90 backdrop-blur-sm p-4 sm:p-6 rounded-2xl shadow-xl border border-blue-100">
              <Calendar
                onClickDay={handleDayClick}
                value={activeMonth}
                tileContent={createTileContent(activeMonth)}
                onActiveStartDateChange={({ activeStartDate }) =>
                  setActiveMonth(activeStartDate || new Date())
                }
                locale="en-US"
              />
            </div>
            <div className="bg-white/90 backdrop-blur-sm p-4 sm:p-6 rounded-2xl shadow-xl border border-blue-100">
              <Calendar
                onClickDay={handleDayClick}
                tileContent={createTileContent(
                  new Date(
                    activeMonth.getFullYear(),
                    activeMonth.getMonth() + 1,
                    1,
                  ),
                )}
                locale="en-US"
                activeStartDate={
                  new Date(
                    activeMonth.getFullYear(),
                    activeMonth.getMonth() + 1,
                    1,
                  )
                }
                onActiveStartDateChange={() => {}} // Prevent navigation on the second calendar
              />
            </div>
          </div>
        </main>
      </div>

      <div
        ref={fabRef}
        className="fixed bottom-5 right-5 z-40 flex flex-col items-end gap-3 sm:bottom-6 sm:right-6"
      >
        {isFabOpen && (
          <div className="flex flex-col items-end gap-2">
            <button
              type="button"
              onClick={() => {
                setIsChatOpen((prev) => !prev);
                setIsFabOpen(false);
              }}
              className="relative flex h-12 items-center gap-2 rounded-full bg-white/95 px-4 text-sm font-medium text-gray-800 shadow-lg ring-1 ring-black/5 transition-transform hover:scale-[1.02] hover:bg-blue-50"
            >
              <MessageCircle className="h-4 w-4 text-blue-600" />
              <span>채팅</span>
              {totalUnreadCount > 0 && (
                <span className="rounded-full bg-red-500 px-2 py-0.5 text-[11px] font-semibold text-white">
                  {totalUnreadCount > 99 ? "99+" : totalUnreadCount}
                </span>
              )}
            </button>
            <button
              type="button"
              onClick={() => {
                setIsAccountModalOpen(true);
                setIsFabOpen(false);
              }}
              className="flex h-12 items-center gap-2 rounded-full bg-white/95 px-4 text-sm font-medium text-gray-800 shadow-lg ring-1 ring-black/5 transition-transform hover:scale-[1.02] hover:bg-blue-50"
            >
              <User className="h-4 w-4 text-gray-700" />
              <span>프로필</span>
            </button>
            <button
              type="button"
              onClick={logout}
              className="flex h-12 items-center gap-2 rounded-full bg-white/95 px-4 text-sm font-medium text-red-600 shadow-lg ring-1 ring-black/5 transition-transform hover:scale-[1.02] hover:bg-red-50"
            >
              <LogOut className="h-4 w-4" />
              <span>로그아웃</span>
            </button>
          </div>
        )}
        <button
          type="button"
          onClick={() => setIsFabOpen((prev) => !prev)}
          className="relative flex h-14 w-14 items-center justify-center rounded-full bg-blue-600 text-white shadow-xl transition-transform hover:scale-105 hover:bg-blue-500"
        >
          <span
            className={`absolute h-5 w-0.5 rounded bg-white transition-transform ${isFabOpen ? "rotate-90" : "rotate-0"}`}
          />
          <span className="absolute h-0.5 w-5 rounded bg-white" />
          {totalUnreadCount > 0 && !isFabOpen && (
            <span className="absolute -right-1 -top-1 min-w-6 rounded-full bg-red-500 px-1.5 py-0.5 text-[11px] font-semibold text-white">
              {totalUnreadCount > 99 ? "99+" : totalUnreadCount}
            </span>
          )}
        </button>
      </div>

      {isChatOpen && (
        <div
          ref={chatWindowRef}
          className="fixed inset-x-3 bottom-24 z-40 flex h-[min(70vh,620px)] w-auto overflow-hidden rounded-3xl border border-blue-100 bg-white shadow-2xl sm:inset-x-auto sm:right-6 sm:w-[min(92vw,840px)]"
        >
          <div
            className={`${isMobileContactListOpen ? "flex" : "hidden"} w-[42%] min-w-[120px] max-w-[280px] flex-col border-r border-gray-100 bg-gray-50/80 sm:flex sm:w-72`}
          >
            <div className="border-b border-gray-100 px-5 py-4">
              <h3 className="text-lg font-semibold text-gray-900">채팅</h3>
              <p className="mt-1 text-xs text-gray-500">
                상대를 선택해 일정과 결과를 대화하세요.
              </p>
            </div>
            <div className="flex-1 overflow-y-auto p-3">
              <div className="space-y-2">
                {contacts.map((contact) => (
                  <button
                    key={contact.name}
                    type="button"
                    onClick={() => {
                      setSelectedChatUsername(contact.name);
                      setContacts((prev) =>
                        prev.map((item) =>
                          item.name === contact.name
                            ? { ...item, unreadCount: 0 }
                            : item,
                        ),
                      );
                      setIsMobileContactListOpen(false);
                    }}
                    className={`flex w-full items-center gap-3 rounded-2xl px-4 py-3 text-left transition-colors ${
                      selectedChatUsername === contact.name
                        ? "bg-blue-600 text-white shadow"
                        : "bg-white text-gray-900 hover:bg-blue-50"
                    }`}
                  >
                    <div
                      className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-sm font-semibold ${
                        selectedChatUsername === contact.name
                          ? "bg-white/20 text-white"
                          : "bg-blue-100 text-blue-700"
                      }`}
                    >
                      {contact.name.slice(0, 1)}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate font-medium">
                          {contact.name}
                        </span>
                        {!!contact.unreadCount && contact.unreadCount > 0 && (
                          <span
                            className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${selectedChatUsername === contact.name ? "bg-white text-blue-600" : "bg-red-500 text-white"}`}
                          >
                            {contact.unreadCount}
                          </span>
                        )}
                      </div>
                      <div
                        className={`mt-1 text-xs ${selectedChatUsername === contact.name ? "text-blue-100" : "text-gray-500"}`}
                      >
                        {user?.role === "admin" && !contact.granted
                          ? "승인 대기 사용자"
                          : "채팅으로 일정 상의 가능"}
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          </div>
          <div
            className={`flex min-w-0 flex-1 flex-col bg-white ${isMobileContactListOpen ? "hidden sm:flex" : "flex"}`}
          >
            <div className="flex items-center justify-between border-b border-gray-100 px-4 py-4 sm:px-6">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setIsMobileContactListOpen((prev) => !prev)}
                  className="inline-flex h-9 w-9 items-center justify-center rounded-full text-gray-500 hover:bg-gray-100 sm:hidden"
                >
                  {isMobileContactListOpen ? (
                    <ChevronLeft className="h-5 w-5" />
                  ) : (
                    <Menu className="h-5 w-5" />
                  )}
                </button>
                <div>
                  <h4 className="font-semibold text-gray-900">
                    {selectedChatUsername || "대화 상대를 선택하세요"}
                  </h4>
                  <p className="mt-1 text-xs text-gray-500">
                    예약 날짜, 시간, 메모, 결과를 바로 공유할 수 있어요.
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setIsChatOpen(false)}
                className="rounded-full px-3 py-1 text-sm text-gray-500 hover:bg-gray-100"
              >
                닫기
              </button>
            </div>
            <div
              ref={chatScrollRef}
              className="flex-1 overflow-y-auto bg-[#eef3fb] px-3 py-4 sm:px-4 sm:py-5"
            >
              <div className="space-y-3">
                {messagesLoading && messages.length === 0 ? (
                  <p className="text-sm text-gray-500">대화 불러오는 중...</p>
                ) : messages.length === 0 ? (
                  <div className="rounded-2xl bg-white px-4 py-3 text-sm text-gray-500 shadow-sm">
                    아직 채팅이 없습니다. 첫 메시지를 보내보세요.
                  </div>
                ) : (
                  messages.map((message) => {
                    const mine = message.senderUsername === user?.name;
                    const otherReadCount = mine
                      ? Math.max(
                          0,
                          (message.readBy || []).filter(
                            (reader) => reader !== user?.name,
                          ).length,
                        )
                      : 0;
                    const unreadReceiptCount = mine
                      ? Math.max(0, 1 - otherReadCount)
                      : 0;
                    return (
                      <div
                        key={message.id}
                        className={`flex ${mine ? "justify-end" : "justify-start"}`}
                      >
                        <div className="max-w-[90%] sm:max-w-[78%]">
                          <div
                            className={`mb-1 flex items-center gap-1 px-1 text-[11px] text-gray-500 ${mine ? "justify-end" : "justify-start"}`}
                          >
                            {!mine && <span>{message.senderUsername}</span>}
                            {!mine && <span>·</span>}
                            <span>
                              {moment(message.createdAt).format("MM/DD HH:mm")}
                            </span>
                          </div>
                          <div
                            className={`flex items-end gap-1 ${mine ? "justify-end" : "justify-start"}`}
                          >
                            {mine && (
                              <span className="pb-1 text-[11px] font-medium text-yellow-700">
                                {unreadReceiptCount > 0
                                  ? unreadReceiptCount
                                  : ""}
                              </span>
                            )}
                            <div
                              className={`rounded-3xl px-4 py-3 shadow-sm ${mine ? "bg-[#ffe812] text-gray-900" : "bg-white text-gray-900"}`}
                            >
                              <div className="whitespace-pre-wrap text-sm leading-6">
                                {message.body}
                              </div>
                              {message.bookingContext?.date && (
                                <div className="mt-3 rounded-2xl border border-black/5 bg-black/5 px-3 py-2 text-xs leading-5">
                                  <div>
                                    {message.bookingContext.date}{" "}
                                    {message.bookingContext.startTime}-
                                    {message.bookingContext.endTime}
                                  </div>
                                  <div>
                                    상태: {message.bookingContext.status || "-"}
                                  </div>
                                  <div>
                                    부킹:{" "}
                                    {message.bookingContext.bookedTime || "-"}
                                  </div>
                                  <div>
                                    메모:{" "}
                                    {message.bookingContext.memo ||
                                      "(메모 없음)"}
                                  </div>
                                </div>
                              )}
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
            <div className="border-t border-gray-100 bg-white px-3 py-3 sm:px-4 sm:py-4">
              <div className="flex items-end gap-2 sm:gap-3">
                <textarea
                  ref={chatInputRef}
                  value={messageBody}
                  onChange={(e) => setMessageBody(e.target.value)}
                  onKeyDown={handleChatInputKeyDown}
                  rows={2}
                  placeholder="Enter 전송, Shift+Enter 줄바꿈"
                  className="min-h-[52px] flex-1 rounded-2xl border border-gray-300 bg-gray-50 px-3 py-3 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-400 resize-none sm:min-h-[56px] sm:px-4"
                />
                <button
                  type="button"
                  onClick={() => void sendMessage()}
                  disabled={!selectedChatUsername || sendingMessage}
                  className="rounded-2xl bg-blue-600 px-4 py-3 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-60 sm:px-5"
                >
                  {sendingMessage ? "전송 중..." : "보내기"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

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

      {isHistoryModalOpen && selectedBooking && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-gradient-to-br from-blue-100 via-white to-gray-100 p-4"
          onClick={() => setIsHistoryModalOpen(false)}
        >
          <div
            className="relative w-full max-w-md rounded-2xl border border-gray-200 bg-white p-8 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              onClick={() => setIsHistoryModalOpen(false)}
              className="absolute right-4 top-4 text-gray-400 transition-colors hover:text-blue-500"
            >
              <span className="sr-only">닫기</span>×
            </button>
            <h3 className="text-2xl font-bold mb-4 text-gray-800 flex items-baseline gap-2">
              <span>예약 내역</span>
              {selectedDate && (
                <span className="text-sm font-medium text-gray-500">
                  {selectedDate.toLocaleDateString("ko-KR", {
                    year: "numeric",
                    month: "2-digit",
                    day: "2-digit",
                    weekday: "short",
                  })}
                </span>
              )}
            </h3>
            {selectedBooking.teeTotal != null && (
              <div className="mb-4 flex flex-wrap items-center gap-2 text-[11px] text-gray-500">
                <span className="mr-1">이 시간대 기준 티 현황:</span>
                <span className="inline-flex items-center gap-1 rounded-full bg-blue-100 px-2 py-0.5 text-blue-700">
                  <span>●</span>
                  <span>전체 {selectedBooking.teeTotal}개</span>
                </span>
                <span className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 text-gray-700">
                  <span>①</span>
                  <span>
                    1부(09:00 이전) {selectedBooking.teeFirstHalf ?? 0}개
                  </span>
                </span>
                <span className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 text-gray-700">
                  <span>②</span>
                  <span>
                    2부(09:00 이후) {selectedBooking.teeSecondHalf ?? 0}개
                  </span>
                </span>
                <span className="inline-flex items-center gap-1 rounded-full bg-blue-50 px-2 py-0.5 text-blue-700">
                  <span>◎</span>
                  <span>내 예약 범위 {selectedBooking.teeInRange ?? 0}개</span>
                </span>
              </div>
            )}
            <div className="space-y-5 text-sm text-gray-800">
              <div className="space-y-1.5">
                <p className="text-sm font-semibold text-gray-700">계정</p>
                <div className="rounded-lg border border-blue-100 bg-blue-50 px-4 py-3 font-semibold text-gray-900">
                  {selectedBooking.account}
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <p className="text-sm font-semibold text-gray-700">
                    신청 시간
                  </p>
                  <div className="rounded-lg border border-blue-100 bg-blue-50 px-4 py-3 font-mono text-gray-900">
                    {selectedBooking.startTime} - {selectedBooking.endTime}
                  </div>
                </div>
                <div className="space-y-1.5">
                  <p className="text-sm font-semibold text-gray-700">
                    부킹 시간
                  </p>
                  <div className="rounded-lg border border-blue-100 bg-blue-50 px-4 py-3 font-mono text-gray-900">
                    {selectedBooking.bookedSlot?.bk_time ||
                      selectedBooking.successTime ||
                      "-"}
                  </div>
                </div>
              </div>
              <div className="space-y-1.5">
                <p className="text-sm font-semibold text-gray-700">상태</p>
                <div className="rounded-lg border border-gray-200 bg-gray-50 px-4 py-3 text-gray-900">
                  {selectedBooking.status}
                </div>
              </div>
              <div className="space-y-1.5">
                <p className="text-sm font-semibold text-gray-700">메모</p>
                <div className="min-h-[56px] whitespace-pre-wrap rounded-lg border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-800">
                  {selectedBooking.memo?.trim() || "(메모 없음)"}
                </div>
              </div>
            </div>
            <div className="mt-6 flex justify-end">
              {selectedBooking.status === "실패" && (
                <div className="mr-2 flex gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setIsHistoryModalOpen(false);
                      setIsNewBookingModalOpen(true);
                    }}
                    className="rounded-lg bg-blue-500 px-4 py-2 text-sm text-white transition-colors hover:bg-blue-600"
                  >
                    내용 변경
                  </button>
                  <button
                    type="button"
                    onClick={handleRetryBookingImmediately}
                    className="rounded-lg bg-gray-100 px-4 py-2 text-sm text-gray-700 transition-colors hover:bg-gray-200"
                  >
                    즉시 재시도
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      handleDeleteBooking();
                      setIsHistoryModalOpen(false);
                    }}
                    className="rounded-lg bg-red-500 px-4 py-2 text-sm text-white transition-colors hover:bg-red-600"
                  >
                    삭제
                  </button>
                </div>
              )}
              <button
                type="button"
                onClick={() => setIsHistoryModalOpen(false)}
                className="rounded-lg bg-gray-100 px-4 py-2 text-sm text-gray-700 transition-colors hover:bg-gray-200"
              >
                닫기
              </button>
            </div>
          </div>
        </div>
      )}

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
