import React, { useState, useEffect } from "react";
import moment from "moment";
import "moment-timezone";
import axios from "axios";
import {
  ChevronUp,
  ChevronDown,
  ChevronsUp,
  ChevronsDown,
  X,
} from "lucide-react";
import { API_BASE_URL } from "./config";
import useAuthStore from "@/store/authStore";

// Interfaces (assuming they are defined as before)
interface Account {
  name: string;
  loginId: string;
  loginPassword: string;
}

interface Booking {
  account: string;
  status: "예약" | "접수" | "재시도" | "성공" | "실패";
  successTime?: string | null;
  bookedSlot?: { bk_time: string; bk_cours: string } | null;
  startTime: string;
  endTime: string;
}

interface NewBookingFormProps {
  selectedDate: Date;
  onBookingAdded: () => void;
  onBookingUpdated: (updatedBooking: {
    startTime: string;
    endTime: string;
  }) => void;
  onBookingDeleted: () => void;
  isOpen: boolean;
  onClose: () => void;
  editingBooking: Booking | null;
}

interface TimeInputProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  onAdjust: (amount: number) => void;
}

const TimeInput: React.FC<TimeInputProps> = ({
  label,
  value,
  onChange,
  onAdjust,
}) => {
  // 0600~1500 범위 validation
  const clamp = (val: string) => {
    let num = parseInt(val);
    if (isNaN(num)) return "0600";
    if (num < 600) return "0600";
    if (num > 1500) return "1500";
    return val.padStart(4, "0");
  };
  return (
    <div>
      <label className="block text-sm font-semibold text-gray-700 mb-2">
        {label}
      </label>
      <div className="relative">
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(clamp(e.target.value.replace(/[^0-9]/g, "")))}
        placeholder="0000"
        maxLength={4}
        className="w-full pl-4 pr-20 py-3 border border-gray-300 rounded-lg bg-white text-gray-900 focus:ring-2 focus:ring-blue-400 focus:border-transparent transition-all font-mono text-lg tracking-widest"
        required
      />
      <div className="absolute inset-y-0 right-2 flex flex-row items-center gap-1">
        <div className="flex flex-col gap-0.5">
          <button
            type="button"
            onClick={() => onAdjust(60)}
            disabled={parseInt(value) >= 1500}
            className="p-0.5 text-blue-400 hover:text-blue-600 disabled:text-gray-300"
          >
            <ChevronsUp className="h-5 w-5" />
          </button>
          <button
            type="button"
            onClick={() => onAdjust(-60)}
            disabled={parseInt(value) <= 600}
            className="p-0.5 text-blue-400 hover:text-blue-600 disabled:text-gray-300"
          >
            <ChevronsDown className="h-5 w-5" />
          </button>
        </div>
        <div className="flex flex-col gap-0.5">
          <button
            type="button"
            onClick={() => onAdjust(10)}
            disabled={parseInt(value) >= 1500}
            className="p-0.5 text-blue-400 hover:text-blue-600 disabled:text-gray-300"
          >
            <ChevronUp className="h-5 w-5" />
          </button>
          <button
            type="button"
            onClick={() => onAdjust(-10)}
            disabled={parseInt(value) <= 600}
            className="p-0.5 text-blue-400 hover:text-blue-600 disabled:text-gray-300"
          >
            <ChevronDown className="h-5 w-5" />
          </button>
        </div>
      </div>
      </div>
    </div>
  );
};

const NewBookingForm: React.FC<NewBookingFormProps> = ({
  selectedDate,
  onBookingAdded,
  onBookingUpdated,
  onBookingDeleted,
  isOpen,
  onClose,
  editingBooking,
}) => {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [selectedAccount, setSelectedAccount] = useState("");
  const [startTime, setStartTime] = useState("0600");
  const [endTime, setEndTime] = useState("0900");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const user = useAuthStore((state) => state.user);
  const logout = useAuthStore((state) => state.logout);

  const isEditMode = !!editingBooking;

  // 예약 성공 상태를 감지하기 위한 간단한 폴링 함수
  const pollUntilSuccess = async (
    account: string,
    dateStr: string,
    timeoutMs = 60000,
    intervalMs = 1500
  ) => {
    const start = Date.now();
    return new Promise<void>((resolve, reject) => {
      const timer = setInterval(async () => {
        try {
          const res = await axios.get<Record<string, Booking[]>>(`${API_BASE_URL}/api/bookings`);
          const data = res.data;
          const day = data[dateStr] || [];
          const match = day.find((b: any) => b.account === account);
          if (match && match.status === "성공") {
            clearInterval(timer);
            resolve();
          } else if (Date.now() - start > timeoutMs) {
            clearInterval(timer);
            reject(new Error("예약 성공 확인 시간 초과"));
          }
        } catch (e) {
          if (axios.isAxiosError(e) && e.response?.status === 401) {
            clearInterval(timer);
            logout();
            reject(new Error("세션이 만료되었습니다."));
            return;
          }
          if (Date.now() - start > timeoutMs) {
            clearInterval(timer);
            reject(new Error("예약 성공 확인 시간 초과"));
          }
        }
      }, intervalMs);
    });
  };

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

  useEffect(() => {
    const fetchAccounts = async () => {
      try {
        const response = await axios.get<Account[]>(`${API_BASE_URL}/api/accounts`);
        const data = Array.isArray(response.data) ? response.data : [];
        setAccounts(data);
        const defaultAccount = isEditMode
          ? editingBooking.account
          : data[0]?.name ?? user?.name ?? "";
        setSelectedAccount(defaultAccount);
        if (isEditMode) {
          setStartTime(editingBooking.startTime);
          setEndTime(editingBooking.endTime);
        } else {
          setStartTime("0600");
          setEndTime("0900");
        }
      } catch (error) {
        console.error("계정 정보를 가져오는 데 실패했습니다:", error);
        if (axios.isAxiosError(error) && error.response?.status === 401) {
          showToast("세션이 만료되었습니다. 다시 로그인해주세요.", "error");
          logout();
        }
      }
    };
    if (isOpen) {
      fetchAccounts();
      setError(null);
      setSuccess(null);
      setLoading(false);
    }
  }, [isOpen, editingBooking, isEditMode]);

  const adjustTime = (
    time: string,
    setTime: (time: string) => void,
    amount: number
  ) => {
    const m = moment(time, "HHmm").add(amount, "minutes");
    const min = moment("0600", "HHmm");
    const max = moment("1500", "HHmm");
    if (m.isBefore(min)) {
      setTime("0600");
      return;
    }
    if (m.isAfter(max)) {
      setTime("1500");
      return;
    }
    setTime(m.format("HHmm"));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccess(null);
    if (loading) return;
    setLoading(true);
    showToast("예약 신청 중...", "info");

    const account = accounts.find((a) => a.name === selectedAccount);
    if (!account) {
      setError("계정을 선택해주세요.");
      setLoading(false);
      return;
    }

    if (!account.loginPassword) {
      const message = "골프장 비밀번호가 비어 있습니다. 계정 관리에서 먼저 저장해주세요.";
      setError(message);
      setLoading(false);
      showToast(message, "error");
      return;
    }

    const bookingData = {
      account: account.name,
      TARGET_DATE: moment(selectedDate).format("YYYYMMDD"),
      START_TIME: startTime,
      END_TIME: endTime,
      status: "접수",
    };

    try {
      const bookingResponse = await axios.post(`${API_BASE_URL}/api/bookings`, {
        NAME: bookingData.account,
        TARGET_DATE: bookingData.TARGET_DATE,
        START_TIME: bookingData.START_TIME,
        END_TIME: bookingData.END_TIME,
      });

      if (bookingResponse.status === 200) {
        const message =
          (bookingResponse.data as { message?: string })?.message ||
          "이미 예약된 일정입니다. 캘린더에서 확인해주세요.";
        setSuccess(message);
        showToast(message, "info");
        onBookingAdded();
        setLoading(false);
        setTimeout(() => onClose(), 1500);
        return;
      }

      const response = await axios.post(`${API_BASE_URL}/api/submit-booking`, {
        ...bookingData,
        force: true,
      });

      const submitMessage = response.data.message || "예약이 등록되었습니다.";
      setSuccess(submitMessage);
      showToast(submitMessage, "success");

      const shouldPoll = !submitMessage.includes("큐");
      if (shouldPoll) {
        try {
          await pollUntilSuccess(bookingData.account, bookingData.TARGET_DATE);
          showToast("예약이 성공 처리되었습니다.", "success");
        } catch (_) {
          // 타임아웃 시에도 조용히 무시
        }
      }

      onBookingAdded();
      setTimeout(() => onClose(), 2000);
    } catch (err: any) {
      if (axios.isAxiosError(err) && err.response?.status === 409) {
        const message =
          err.response.data?.message ||
          "이미 예약이 존재하여 변경/추가할 수 없습니다.";
        setError(message);
        showToast(message, "error");
        onBookingAdded();
      } else {
        const message = err?.message || "예약 신청에 실패했습니다.";
        setError(message);
        showToast(message, "error");
        if (axios.isAxiosError(err) && err.response?.status === 401) {
          logout();
        }
      }
    } finally {
      setLoading(false);
    }
  };

  const handleUpdate = async () => {
    setError(null);
    setSuccess(null);
    if (loading) return;
    setLoading(true);
    showToast("예약 변경 신청 중...", "info");
    try {
      await onBookingUpdated({ startTime, endTime });

      const bookingData = {
        ...editingBooking,
        TARGET_DATE: moment(selectedDate).format("YYYYMMDD"),
        startTime,
        endTime,
      } as Booking & { TARGET_DATE: string };
      // @ts-ignore 제거를 위해 date 삭제 후 타입 재정의
      delete (bookingData as any).date;

      const response = await axios.post(`${API_BASE_URL}/api/submit-booking`, {
        ...bookingData,
        force: true,
      });

      const submitMessage = response.data.message || "예약이 변경되었습니다.";
      setSuccess(submitMessage);
      showToast(submitMessage, "success");
      onBookingAdded();

      const shouldPoll = !submitMessage.includes("큐");
      if (shouldPoll) {
        try {
          await pollUntilSuccess(
            (editingBooking as Booking).account,
            moment(selectedDate).format("YYYYMMDD")
          );
          showToast("예약이 성공 처리되었습니다.", "success");
          onBookingAdded();
        } catch (_) {}
      }
      setTimeout(() => onClose(), 2000);
    } catch (err: any) {
      if (axios.isAxiosError(err) && err.response?.status === 409) {
        const message =
          err.response.data?.message || "이미 예약이 존재하여 변경할 수 없습니다.";
        setError(message);
        showToast(message, "error");
        onBookingAdded();
      } else {
        const message = err?.message || "예약 변경 및 실행에 실패했습니다.";
        setError(message);
        showToast(message, "error");
        if (axios.isAxiosError(err) && err.response?.status === 401) {
          logout();
        }
      }
    } finally {
      setLoading(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 bg-gradient-to-br from-blue-100 via-white to-pink-100 flex justify-center items-center z-50 p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-8 relative border border-blue-100"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={onClose}
          className="absolute top-4 right-4 text-gray-400 hover:text-blue-400 transition-colors"
        >
          <X className="w-6 h-6" />
        </button>
        <h3 className="text-2xl font-bold mb-6 text-gray-800">
          {isEditMode ? "예약 변경" : "신규 예약"}
        </h3>
        <form onSubmit={handleSubmit} className="space-y-5">
          <div>
            <label className="block text-sm font-semibold text-gray-700 mb-2">
              계정
            </label>
            {user?.role === "admin" ? (
              <div className="relative">
                <select
                  value={selectedAccount}
                  onChange={(e) => setSelectedAccount(e.target.value)}
                  className="w-full appearance-none px-4 py-3 border border-blue-200 rounded-lg bg-blue-50 text-gray-900 focus:ring-2 focus:ring-blue-400 focus:border-transparent transition-all shadow-sm font-semibold"
                  required
                  disabled={isEditMode}
                  style={{ boxShadow: "0 2px 8px 0 rgba(0,0,0,0.04)" }}
                >
                  <option value="" className="text-gray-400">
                    계정을 선택하세요
                  </option>
                  {accounts.map((account, index) => (
                    <option
                      key={index}
                      value={account.name}
                      className="bg-white text-gray-900 hover:bg-blue-100"
                    >
                      {account.name}
                    </option>
                  ))}
                </select>
                <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center px-2 text-blue-400">
                  <ChevronDown className="h-4 w-4" />
                </div>
              </div>
            ) : (
              <div className="px-4 py-3 border border-blue-200 rounded-lg bg-blue-50 text-gray-900 font-semibold">
                {selectedAccount || "연결된 계정이 없습니다"}
              </div>
            )}
          </div>
          <div className="grid grid-cols-2 gap-4">
            <TimeInput
              label="시작 시간"
              value={startTime}
              onChange={setStartTime}
              onAdjust={(amount) => adjustTime(startTime, setStartTime, amount)}
            />
            <TimeInput
              label="종료 시간"
              value={endTime}
              onChange={setEndTime}
              onAdjust={(amount) => adjustTime(endTime, setEndTime, amount)}
            />
          </div>

          {isEditMode ? (
            <div className="flex justify-end space-x-3 pt-2">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 rounded-lg bg-gray-100 text-gray-700 hover:bg-blue-50 transition-colors"
              >
                취소
              </button>
              <button
                type="button"
                onClick={!loading ? onBookingDeleted : undefined}
                disabled={loading}
                className={`px-4 py-2 rounded-lg text-white transition-colors ${
                  loading
                    ? "bg-red-300 cursor-not-allowed opacity-60"
                    : "bg-red-400 hover:bg-red-500"
                }`}
              >
                삭제
              </button>
              <button
                type="button"
                onClick={handleUpdate}
                disabled={loading}
                className={`px-4 py-2 rounded-lg text-white transition-colors ${
                  loading
                    ? "bg-blue-300 cursor-not-allowed opacity-60"
                    : "bg-blue-400 hover:bg-blue-500"
                }`}
              >
                {loading ? "처리 중..." : "변경"}
              </button>
            </div>
          ) : (
            <button
              type="submit"
              disabled={loading}
              className={`w-full text-white font-semibold py-3 px-6 rounded-lg shadow-lg transition-all duration-200 ${
                loading
                  ? "bg-blue-300 cursor-not-allowed opacity-60"
                  : "bg-blue-400 hover:bg-blue-500"
              }`}
            >
              {loading ? "처리 중..." : "예약 추가"}
            </button>
          )}

          {false && error}
          {false && success}
        </form>
      </div>
    </div>
  );
};

export default NewBookingForm;
