import React, { useState, useEffect } from "react";
import moment from "moment";
import "moment-timezone";
import {
  ChevronUp,
  ChevronDown,
  ChevronsUp,
  ChevronsDown,
  X,
} from "lucide-react";

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
    <div className="relative">
      <label className="block text-sm font-semibold text-gray-700 mb-2">
        {label}
      </label>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(clamp(e.target.value.replace(/[^0-9]/g, "")))}
        placeholder="0000"
        maxLength={4}
        className="w-full pl-4 pr-20 py-3 border border-gray-300 rounded-lg bg-white text-gray-900 focus:ring-2 focus:ring-blue-400 focus:border-transparent transition-all font-mono text-lg tracking-widest"
        required
      />
      <div className="absolute right-2 top-1/2 -translate-y-1/2 flex flex-row gap-1 h-full justify-center">
        <div className="flex flex-col gap-0.5 h-full justify-center">
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
        <div className="flex flex-col gap-0.5 h-full justify-center">
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

  const isEditMode = !!editingBooking;

  useEffect(() => {
    const fetchAccounts = async () => {
      try {
        const response = await fetch("http://localhost:3001/api/accounts");
        const data = await response.json();
        setAccounts(data);
        if (isEditMode) {
          setSelectedAccount(editingBooking.account);
          setStartTime(editingBooking.startTime);
          setEndTime(editingBooking.endTime);
        } else {
          setSelectedAccount("");
          setStartTime("0600");
          setEndTime("0900");
        }
      } catch (error) {
        console.error("계정 정보를 가져오는 데 실패했습니다:", error);
      }
    };
    if (isOpen) {
      fetchAccounts();
      setError(null);
      setSuccess(null);
    }
  }, [isOpen, editingBooking, isEditMode]);

  const adjustTime = (
    time: string,
    setTime: (time: string) => void,
    amount: number
  ) => {
    const newTime = moment(time, "HHmm").add(amount, "minutes").format("HHmm");
    setTime(newTime);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccess(null);

    const account = accounts.find((a) => a.name === selectedAccount);
    if (!account) {
      setError("계정을 선택해주세요.");
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
      // 1. Save booking to DB
      await fetch("http://localhost:3001/api/bookings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          NAME: bookingData.account,
          TARGET_DATE: bookingData.TARGET_DATE,
          START_TIME: bookingData.START_TIME,
          END_TIME: bookingData.END_TIME,
        }),
      });

      const response = await fetch("http://localhost:3001/api/submit-booking", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(bookingData),
      });
      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.message || "예약 제출에 실패했습니다.");
      }

      setSuccess(result.message);
      setTimeout(() => {
        onBookingAdded();
        onClose();
      }, 1500);
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleUpdate = async () => {
    setError(null);
    setSuccess(null);
    try {
      // 1. Update booking times in the database
      await onBookingUpdated({ startTime, endTime });

      const bookingData = {
        ...editingBooking,
        TARGET_DATE: moment(selectedDate).format("YYYYMMDD"),
        startTime,
        endTime,
      };
      // @ts-ignore
      delete bookingData.date; // 기존의 date 속성 제거

      const response = await fetch("http://localhost:3001/api/submit-booking", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(bookingData),
      });
      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.message || "예약 제출에 실패했습니다.");
      }

      setSuccess(result.message);
      setTimeout(() => {
        onClose();
      }, 1500);
    } catch (err: any) {
      setError(err.message || "예약 변경 및 실행에 실패했습니다.");
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
                onClick={onBookingDeleted}
                className="px-4 py-2 rounded-lg bg-red-400 text-white hover:bg-red-500 transition-colors"
              >
                삭제
              </button>
              <button
                type="button"
                onClick={handleUpdate}
                className="px-4 py-2 rounded-lg bg-blue-400 text-white hover:bg-blue-500 transition-colors"
              >
                변경
              </button>
            </div>
          ) : (
            <button
              type="submit"
              className="w-full bg-blue-400 hover:bg-blue-500 text-white font-semibold py-3 px-6 rounded-lg shadow-lg transition-all duration-200"
            >
              예약 추가
            </button>
          )}

          {error && (
            <div className="bg-red-100 border border-red-300 text-red-600 px-4 py-3 rounded-lg text-sm">
              {error}
            </div>
          )}
          {success && (
            <div className="bg-green-100 border border-green-300 text-green-700 px-4 py-3 rounded-lg text-sm">
              {success}
            </div>
          )}
        </form>
      </div>
    </div>
  );
};

export default NewBookingForm;
