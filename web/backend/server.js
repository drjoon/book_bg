import express from 'express';
import cors from 'cors';
import fs from 'fs/promises';
import path from 'path';

const app = express();
const PORT = 3001;

app.use(cors());
app.use(express.json());

const BOOKLIST_DIR = path.resolve(process.cwd(), '../../booklist');
const CONFIG_PATH = path.resolve(process.cwd(), '../../booking_configs.json');

// dev/book/booklist 디렉토리에서 모든 예약 정보를 읽어오는 API
app.get('/api/bookings', async (req, res) => {
  try {
    const bookingsByDate = {};
    const accountDirs = await fs.readdir(BOOKLIST_DIR, { withFileTypes: true });

    for (const accountDir of accountDirs) {
      if (accountDir.isDirectory()) {
        const accountName = accountDir.name;
        const dateFiles = await fs.readdir(path.join(BOOKLIST_DIR, accountName));

        for (const dateFile of dateFiles) {
          const date = path.basename(dateFile, '.json');
          const filePath = path.join(BOOKLIST_DIR, accountName, dateFile);
          const content = await fs.readFile(filePath, 'utf-8');
          const bookingData = JSON.parse(content);

          if (!bookingsByDate[date]) {
            bookingsByDate[date] = [];
          }

          bookingsByDate[date].push({ 
            account: accountName, 
            ...bookingData 
          });
        }
      }
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
    if (error.code === 'ENOENT') {
        // booklist 폴더가 아직 없는 경우, 빈 객체 반환
        console.log('booklist directory not found, returning empty data.');
        return res.json({});
    }
    console.error('Error fetching bookings:', error);
    res.status(500).json({ message: 'Failed to fetch bookings' });
  }
});

// 계정 목록을 가져오는 API
app.get('/api/accounts', async (req, res) => {
  try {
    const configs = JSON.parse(await fs.readFile(CONFIG_PATH, 'utf-8'));
    const accounts = configs.map(c => ({
      name: c.NAME,
      loginId: c.LOGIN_ID,
      loginPassword: c.LOGIN_PASSWORD
    }));
    // 중복 제거
    const uniqueAccounts = Array.from(new Map(accounts.map(a => [a.name, a])).values());
    res.json(uniqueAccounts);
  } catch (error) {
    console.error('Error fetching accounts:', error);
    res.status(500).json({ message: 'Failed to fetch accounts' });
  }
});

// 신규 예약 생성 (파일 생성)
app.post('/api/bookings', async (req, res) => {
  const { NAME, TARGET_DATE, START_TIME, END_TIME } = req.body;
  if (!NAME || !TARGET_DATE || !START_TIME || !END_TIME) {
    return res.status(400).json({ message: '필수 정보가 누락되었습니다.' });
  }

    try {
    const accountDir = path.join(BOOKLIST_DIR, NAME);
    const filePath = path.join(accountDir, `${TARGET_DATE}.json`);

    // 파일 존재 여부로 중복 체크
    try {
      await fs.access(filePath);
      return res.status(409).json({ message: '해당 날짜에 이미 예약이 존재합니다.' });
    } catch (e) {
      // 파일이 없으면 계속 진행
    }

    await fs.mkdir(accountDir, { recursive: true });

    const newBookingData = {
      status: '접수',
      startTime: START_TIME,
      endTime: END_TIME,
      successTime: null,
      bookedSlot: null,
    };

    await fs.writeFile(filePath, JSON.stringify(newBookingData, null, 2));
    res.status(201).json({ message: '예약이 추가되었습니다.', ...newBookingData });
  } catch (error) {
    console.error('예약 추가 중 오류 발생:', error);
    res.status(500).json({ message: '예약 추가에 실패했습니다.' });
  }
});

// 예약 변경 (파일 수정)
app.put('/api/bookings/:date/:account', async (req, res) => {
  const { date, account } = req.params;
  const { startTime, endTime } = req.body;

  if (!startTime || !endTime) {
    return res.status(400).json({ message: '시작 및 종료 시간이 필요합니다.' });
  }

  try {
    const filePath = path.join(BOOKLIST_DIR, account, `${date}.json`);
    const content = await fs.readFile(filePath, 'utf-8');
    const bookingData = JSON.parse(content);

    bookingData.startTime = startTime;
    bookingData.endTime = endTime;

    await fs.writeFile(filePath, JSON.stringify(bookingData, null, 2));
    res.json({ message: '예약이 변경되었습니다.', ...bookingData });
  } catch (error) {
    console.error('예약 변경 중 오류 발생:', error);
    res.status(500).json({ message: '예약 변경에 실패했습니다.' });
  }
});

// 예약 삭제 (파일 삭제)
app.delete('/api/bookings/:date/:account', async (req, res) => {
  const { date, account } = req.params;

  try {
    const filePath = path.join(BOOKLIST_DIR, account, `${date}.json`);
    await fs.unlink(filePath);
    res.json({ message: '예약이 삭제되었습니다.' });
  } catch (error) {
    if (error.code === 'ENOENT') {
      return res.status(404).json({ message: '삭제할 예약을 찾을 수 없습니다.' });
    }
    console.error('예약 삭제 중 오류 발생:', error);
    res.status(500).json({ message: '예약 삭제에 실패했습니다.' });
  }
});

app.listen(PORT, () => {
  console.log(`Backend server is running on http://localhost:${PORT}`);
});
