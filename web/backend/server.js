import express from 'express';
import cors from 'cors';
import fs from 'fs/promises';
import path from 'path';
import { Booking, Account } from './models.js'; // Import models
import { runAutoBooking, getBookingOpenTime } from '../../auto/debeach_auto.js';
import moment from 'moment-timezone';
import connectDB from './db.js';

import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

connectDB();

const app = express();
const PORT = 3001;

app.use(cors());
app.use(express.json());

const CONFIG_PATH = path.resolve(__dirname, '../../auto/booking_configs.json');
const QUEUE_PATH = path.resolve(__dirname, '../../auto/queue.json');

async function loadQueue() {
  try {
    return JSON.parse(await fs.readFile(QUEUE_PATH, 'utf-8'));
  } catch (e) {
    return [];
  }
}

async function saveQueue(queue) {
  await fs.writeFile(QUEUE_PATH, JSON.stringify(queue, null, 2));
}

async function enqueueOrUpdate(job) {
  const normalized = {
    account: job.account ?? job.NAME,
    date: job.date ?? job.TARGET_DATE,
    startTime: job.startTime ?? job.START_TIME,
    endTime: job.endTime ?? job.END_TIME,
    force: job.force === true,
  };
  if (!normalized.account || !normalized.date) return;
  const queue = await loadQueue();
  const idx = queue.findIndex(
    (q) => q.account === normalized.account && q.date === normalized.date
  );
  if (idx >= 0) {
    queue[idx] = { ...queue[idx], ...normalized };
  } else {
    queue.push(normalized);
  }
  await saveQueue(queue);
}

// 모든 예약 정보를 MongoDB에서 읽어오는 API
app.get('/api/bookings', async (req, res) => {
  try {
    const bookings = await Booking.find({});
    const bookingsByDate = {};

    for (const booking of bookings) {
      const date = booking.date;
      if (!bookingsByDate[date]) {
        bookingsByDate[date] = [];
      }
      bookingsByDate[date].push(booking);
    }

    // 각 날짜별로 bk_time을 기준으로 정렬
    for (const date in bookingsByDate) {
      bookingsByDate[date].sort((a, b) => {
        const timeA = a.bookedSlot?.bk_time || '9999';
        const timeB = b.bookedSlot?.bk_time || '9999';
        return timeA.localeCompare(timeB);
      });
    }

    res.json(bookingsByDate);
  } catch (error) {
    console.error('Error fetching bookings:', error);
    res.status(500).json({ message: 'Failed to fetch bookings' });
  }
});

// 계정 목록을 MongoDB에서 가져오는 API
app.get('/api/accounts', async (req, res) => {
  try {
    const accounts = await Account.find({}, 'name loginId loginPassword');
    res.json(accounts);
  } catch (error) {
    console.error('Error fetching accounts:', error);
    res.status(500).json({ message: 'Failed to fetch accounts' });
  }
});

// 신규 예약 생성 (MongoDB)
app.post('/api/bookings', async (req, res) => {
  const { NAME, TARGET_DATE, START_TIME, END_TIME } = req.body;
  if (!NAME || !TARGET_DATE || !START_TIME || !END_TIME) {
    return res.status(400).json({ message: '필수 정보가 누락되었습니다.' });
  }

  try {
    // 오픈 1분 이내 차단
    const now = moment().tz('Asia/Seoul');
    const openTime = getBookingOpenTime(TARGET_DATE);
    if (now.isSameOrAfter(openTime.clone().subtract(1, 'minute')) && now.isBefore(openTime)) {
      return res.status(409).json({ message: '오픈 1분 이내에는 예약을 추가/수정할 수 없습니다.' });
    }

    const newBooking = new Booking({
      account: NAME,
      date: TARGET_DATE,
      status: '접수',
      startTime: START_TIME,
      endTime: END_TIME,
      successTime: null,
      bookedSlot: null,
    });

    const savedBooking = await newBooking.save();
    await enqueueOrUpdate(savedBooking.toObject());
    res.status(201).json({ message: '예약이 추가되었습니다.', ...savedBooking.toObject() });
  } catch (error) {
    if (error.code === 11000) { // Duplicate key error
      return res.status(409).json({ message: '해당 날짜에 이미 예약이 존재합니다.' });
    }
    console.error('예약 추가 중 오류 발생:', error);
    res.status(500).json({ message: '예약 추가에 실패했습니다.' });
  }
});

// 예약 변경 (MongoDB)
app.put('/api/bookings/:date/:account', async (req, res) => {
  const { date, account } = req.params;
  const { startTime, endTime } = req.body;

  if (!startTime || !endTime) {
    return res.status(400).json({ message: '시작 및 종료 시간이 필요합니다.' });
  }

  try {
    // 오픈 1분 이내 차단
    const now = moment().tz('Asia/Seoul');
    const openTime = getBookingOpenTime(date);
    if (now.isSameOrAfter(openTime.clone().subtract(1, 'minute')) && now.isBefore(openTime)) {
      return res.status(409).json({ message: '오픈 1분 이내에는 예약을 추가/수정할 수 없습니다.' });
    }

    const updatedBooking = await Booking.findOneAndUpdate(
      { date, account },
      { startTime, endTime },
      { new: true } // Return the updated document
    );

    if (!updatedBooking) {
      return res.status(404).json({ message: '변경할 예약을 찾을 수 없습니다.' });
    }

    await enqueueOrUpdate(updatedBooking.toObject());
    res.json({ message: '예약이 변경되었습니다.', ...updatedBooking.toObject() });
  } catch (error) {
    console.error('예약 변경 중 오류 발생:', error);
    res.status(500).json({ message: '예약 변경에 실패했습니다.' });
  }
});

// 예약 삭제 (MongoDB)
app.delete('/api/bookings/:date/:account', async (req, res) => {
  const { date, account } = req.params;

  try {
    const deletedBooking = await Booking.findOneAndDelete({ date, account });

    if (!deletedBooking) {
      return res.status(404).json({ message: '삭제할 예약을 찾을 수 없습니다.' });
    }

    res.json({ message: '예약이 삭제되었습니다.' });
  } catch (error) {
    console.error('예약 삭제 중 오류 발생:', error);
    res.status(500).json({ message: '예약 삭제에 실패했습니다.' });
  }
});

// 통합 예약 요청 API
app.post('/api/submit-booking', async (req, res) => {
  try {
    const body = req.body;
    const job = {
      account: body.account ?? body.NAME,
      date: body.date ?? body.TARGET_DATE,
      startTime: body.startTime ?? body.START_TIME,
      endTime: body.endTime ?? body.END_TIME,
      force: body.force === true,
    };
    // 이미 성공한 예약이면 재실행하지 않음
    try {
      const existing = await Booking.findOne({ account: job.account, date: job.date });
      if (!job.force && existing && existing.status === '성공') {
        return res.json({ message: '이미 성공 상태입니다. 실행을 생략합니다.' });
      }
    } catch (e) {
      console.warn('[API] Pre-check existing booking failed:', e.message);
    }
    const openTime = getBookingOpenTime(job.date);
    const now = moment().tz('Asia/Seoul');

    // 오픈 1분 이내 등록 차단 로직 (큐 등록 시에만)
    if (now.isBefore(openTime)) {
      if (now.isSameOrAfter(openTime.clone().subtract(1, 'minute'))) {
        return res.status(409).json({ message: '오픈 1분 이내에는 자동 예약 등록을 할 수 없습니다.' });
      }
    }

    if (now.isAfter(openTime)) {
      // 즉시 실행
      console.log(`[API] Booking time has passed. Running immediately for ${job.account} on ${job.date}`);
      await runAutoBooking([job], { immediate: true, force: job.force });
      res.json({ message: '즉시 예약을 시작합니다!' });
    } else {
      // 큐에 추가
      console.log(`[API] Queuing booking for ${job.account} on ${job.date}`);
      await enqueueOrUpdate(job);
      res.json({ message: '예약이 큐에 추가되었습니다.' });
    }
  } catch (error) {
    console.error('통합 예약 처리 오류:', error);
    res.status(500).json({ message: '예약 처리에 실패했습니다.' });
  }
});

app.listen(PORT, () => {
  console.log(`Backend server is running on http://localhost:${PORT}`);
});
