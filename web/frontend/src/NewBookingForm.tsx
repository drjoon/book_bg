import React, { useState, useEffect } from 'react';
import moment from 'moment';
import { ChevronUp, ChevronDown, X } from 'lucide-react';

interface Account {
  name: string;
  loginId: string;
  loginPassword: string;
}

interface Booking {
  account: string;
  status: '예약' | '접수' | '재시도' | '성공' | '실패';
  successTime?: string | null;
  bookedSlot?: { bk_time: string; bk_cours: string; } | null;
  startTime: string;
  endTime: string;
}

interface NewBookingFormProps {
  selectedDate: Date;
  onBookingAdded: () => void;
  onBookingUpdated: (updatedBooking: { startTime: string, endTime: string }) => void;
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

const TimeInput: React.FC<TimeInputProps> = ({ label, value, onChange, onAdjust }) => (
  <div className="relative">
    <label className="block text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2">{label}</label>
        <input 
      type="number" 
      value={value} 
      onChange={e => onChange(e.target.value)} 
      placeholder="0000" 
      className="w-full pl-4 pr-10 py-3 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
      required 
    />
    <div className="absolute right-2 top-1/2 -translate-y-1/2 flex flex-col">
      <button type="button" onClick={() => onAdjust(10)} className="p-0.5 text-gray-500 hover:text-gray-800 dark:hover:text-white"><ChevronUp className="h-4 w-4" /></button>
      <button type="button" onClick={() => onAdjust(-10)} className="p-0.5 text-gray-500 hover:text-gray-800 dark:hover:text-white"><ChevronDown className="h-4 w-4" /></button>
    </div>
  </div>
);

const NewBookingForm: React.FC<NewBookingFormProps> = ({ selectedDate, onBookingAdded, onBookingUpdated, onBookingDeleted, isOpen, onClose, editingBooking }) => {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [selectedAccount, setSelectedAccount] = useState('');
  const [startTime, setStartTime] = useState('0600');
  const [endTime, setEndTime] = useState('0900');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const isEditMode = !!editingBooking;

  useEffect(() => {
    const fetchAccounts = async () => {
      try {
        const response = await fetch('http://localhost:3001/api/accounts');
        const data = await response.json();
        setAccounts(data);
        if (isEditMode) {
          setSelectedAccount(editingBooking.account);
          setStartTime(editingBooking.startTime);
          setEndTime(editingBooking.endTime);
        } else {
          setSelectedAccount('');
          setStartTime('0600');
          setEndTime('0900');
        }
      } catch (error) {
        console.error('계정 정보를 가져오는 데 실패했습니다:', error);
      }
    };
    if (isOpen) {
      fetchAccounts();
    }
  }, [isOpen, editingBooking, isEditMode]);

  const adjustTime = (time: string, setTime: (time: string) => void, amount: number) => {
    const newTime = moment(time, 'HHmm').add(amount, 'minutes').format('HHmm');
    if (validateTime(newTime)) setTime(newTime);
  };

  const validateTime = (time: string): boolean => {
    const hour = parseInt(time.substring(0, 2));
    const minute = parseInt(time.substring(2, 4));
    return !(hour < 6 || hour > 14 || (hour === 14 && minute > 30));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccess(null);

    if (!validateTime(startTime)) {
      setError('시작 시간은 06:00과 14:30 사이여야 합니다.');
      return;
    }
    if (!validateTime(endTime)) {
      setError('종료 시간은 06:00과 14:30 사이여야 합니다.');
      return;
    }

    const account = accounts.find(a => a.name === selectedAccount);
    if (!account) {
      setError('계정을 선택해주세요.');
      return;
    }

    const newBooking = {
      NAME: account.name,
      LOGIN_ID: account.loginId,
      LOGIN_PASSWORD: account.loginPassword,
      TARGET_DATE: moment(selectedDate).format('YYYYMMDD'),
      START_TIME: startTime,
      END_TIME: endTime,
    };

    try {
      const response = await fetch('http://localhost:3001/api/bookings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newBooking),
      });

      const data = await response.json();
            if (!response.ok) throw new Error(data.message || '예약 추가에 실패했습니다.');

      setSuccess('예약이 성공적으로 추가되었습니다!');
      setTimeout(() => {
        onBookingAdded();
        onClose();
      }, 1500);
    } catch (err: any) {
      setError(err.message);
    }
  };

    const handleUpdate = () => {
    if (!validateTime(startTime)) {
      setError('시작 시간은 06:00과 14:30 사이여야 합니다.');
      return;
    }
    if (!validateTime(endTime)) {
      setError('종료 시간은 06:00과 14:30 사이여야 합니다.');
      return;
    }
    onBookingUpdated({ startTime, endTime });
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-60 flex justify-center items-center z-50 p-4" onClick={onClose}>
      <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-2xl w-full max-w-md p-6 relative" onClick={e => e.stopPropagation()}>
        <button onClick={onClose} className="absolute top-4 right-4 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 transition-colors">
          <X className="w-6 h-6" />
        </button>
        <h3 className="text-2xl font-bold mb-6 text-gray-900 dark:text-white">{isEditMode ? '예약 변경' : '신규 예약'}</h3>
        <form onSubmit={handleSubmit} className="space-y-5">
          <div>
            <label className="block text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2">계정</label>
            <div className="relative">
              <select value={selectedAccount} onChange={e => setSelectedAccount(e.target.value)} className="w-full appearance-none px-4 py-3 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all" required disabled={isEditMode}>
                <option value="">계정을 선택하세요</option>
                {accounts.map((account, index) => (
                  <option key={index} value={account.name}>{account.name}</option>
                ))}
              </select>
              <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center px-2 text-gray-700 dark:text-gray-300">
                <ChevronDown className="h-4 w-4" />
              </div>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <TimeInput label="시작 시간" value={startTime} onChange={setStartTime} onAdjust={(amount) => adjustTime(startTime, setStartTime, amount)} />
            <TimeInput label="종료 시간" value={endTime} onChange={setEndTime} onAdjust={(amount) => adjustTime(endTime, setEndTime, amount)} />
          </div>

          {isEditMode ? (
            <div className="flex justify-end space-x-3 pt-2">
              <button type="button" onClick={onClose} className="px-4 py-2 rounded-lg bg-gray-200 dark:bg-gray-600 text-gray-800 dark:text-gray-200 hover:bg-gray-300 dark:hover:bg-gray-500 transition-colors">취소</button>
                            <button type="button" onClick={onBookingDeleted} className="px-4 py-2 rounded-lg bg-red-500 text-white hover:bg-red-600 transition-colors">삭제</button>
              <button type="button" onClick={handleUpdate} className="px-4 py-2 rounded-lg bg-blue-500 text-white hover:bg-blue-600 transition-colors">변경</button>
            </div>
          ) : (
            <button type="submit" className="w-full bg-gradient-to-r from-blue-500 to-blue-600 hover:from-blue-600 hover:to-blue-700 text-white font-semibold py-3 px-6 rounded-lg shadow-lg hover:shadow-xl transform hover:scale-[1.02] transition-all duration-200">예약 추가</button>
          )}

          {error && <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-red-600 dark:text-red-400 px-4 py-3 rounded-lg text-sm">{error}</div>}
          {success && <div className="bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 text-green-600 dark:text-green-400 px-4 py-3 rounded-lg text-sm">{success}</div>}
        </form>
      </div>
    </div>
  );
};

export default NewBookingForm;
