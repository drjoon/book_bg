import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import axios from "axios";
import { useNavigate } from "react-router-dom";
import useAuthStore from "@/store/authStore";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { API_BASE_URL } from "@/config";
import { useState, useEffect } from "react";

const loginSchema = z.object({
  name: z.string().min(1, "이름을 입력해주세요."),
  password: z.string().min(1, "비밀번호를 입력해주세요."),
});

const passwordRequestSchema = z.object({
  name: z.string().min(1, "이름을 입력해주세요."),
  currentPassword: z.string().min(1, "현재 비밀번호를 입력해주세요."),
  newPassword: z.string().min(6, "새 비밀번호는 최소 6자 이상이어야 합니다."),
});

type LoginSchema = z.infer<typeof loginSchema>;
type PasswordRequestSchema = z.infer<typeof passwordRequestSchema>;

interface PasswordRequestStatus {
  status: "pending" | "approved" | "rejected";
  createdAt: string;
  reviewedAt?: string | null;
  rejectReason?: string;
}

export default function LoginPage() {
  const navigate = useNavigate();
  const login = useAuthStore((state) => state.login);
  const [isPasswordRequestOpen, setIsPasswordRequestOpen] = useState(false);
  const [recentRequest, setRecentRequest] =
    useState<PasswordRequestStatus | null>(null);
  const {
    register,
    handleSubmit,
    watch,
    formState: { errors, isSubmitting },
    setError,
  } = useForm<LoginSchema>({
    resolver: zodResolver(loginSchema),
  });

  const {
    register: registerPasswordRequest,
    handleSubmit: handleSubmitPasswordRequest,
    formState: {
      errors: passwordRequestErrors,
      isSubmitting: isSubmittingPasswordRequest,
    },
    reset: resetPasswordRequest,
    setValue: setPasswordRequestValue,
  } = useForm<PasswordRequestSchema>({
    resolver: zodResolver(passwordRequestSchema),
  });

  const watchedName = watch("name");

  useEffect(() => {
    if (watchedName) {
      setPasswordRequestValue("name", watchedName);
    }
  }, [watchedName, setPasswordRequestValue]);

  useEffect(() => {
    const trimmedName = String(watchedName || "").trim();
    if (!trimmedName) {
      setRecentRequest(null);
      return;
    }

    const timeoutId = window.setTimeout(async () => {
      try {
        const response = await axios.get(
          `${API_BASE_URL}/api/auth/password-request-status`,
          { params: { name: trimmedName } },
        );
        setRecentRequest(response.data.request || null);
      } catch (error) {
        setRecentRequest(null);
      }
    }, 300);

    return () => window.clearTimeout(timeoutId);
  }, [watchedName]);

  const showToast = (
    message: string,
    type: "success" | "error" | "info" = "info",
  ) => {
    const div = document.createElement("div");
    const baseClass =
      "fixed bottom-6 left-1/2 -translate-x-1/2 z-[9999] px-4 py-3 rounded-lg shadow-lg text-sm text-white pointer-events-none transition-opacity";
    const colorClass =
      type === "success"
        ? "bg-green-500"
        : type === "error"
          ? "bg-red-500"
          : "bg-gray-800";
    div.className = `${baseClass} ${colorClass}`;
    div.textContent = message;
    div.style.opacity = "0";
    document.body.appendChild(div);
    requestAnimationFrame(() => {
      div.style.opacity = "1";
    });
    setTimeout(() => {
      div.style.opacity = "0";
      setTimeout(() => {
        div.remove();
      }, 300);
    }, 2000);
  };

  const onSubmit = async (data: LoginSchema) => {
    try {
      const response = await axios.post(`${API_BASE_URL}/api/auth/login`, data);
      const { token, user } = response.data;
      login(token, user);
      navigate("/");
    } catch (error: any) {
      if (error.response?.status === 403) {
        navigate("/pending-approval", {
          state: { name: data.name },
        });
        return;
      }
      const message =
        error.response?.data?.message ||
        "로그인에 실패했습니다. 입력 정보를 확인해주세요.";
      setError("root", { type: "manual", message });
      showToast(message, "error");
    }
  };

  const onSubmitPasswordRequest = async (data: PasswordRequestSchema) => {
    try {
      const response = await axios.post(
        `${API_BASE_URL}/api/auth/password-request`,
        data,
      );
      showToast(response.data.message, "success");
      setRecentRequest(response.data.request || null);
      resetPasswordRequest();
      setIsPasswordRequestOpen(false);
    } catch (error: any) {
      const message =
        error.response?.data?.message ||
        "비밀번호 변경 요청에 실패했습니다. 입력 정보를 확인해주세요.";
      showToast(message, "error");
    }
  };

  return (
    <div className="flex items-center justify-center min-h-screen bg-gray-100">
      <Card className="mx-auto max-w-sm">
        <CardHeader>
          <CardTitle className="text-2xl font-bold text-gray-900">
            로그인
          </CardTitle>
          <CardDescription className="text-sm text-gray-600">
            서비스 이용을 위해 이름과 비밀번호를 입력해주세요.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {recentRequest && (
            <div
              className={`mb-4 rounded-xl border px-4 py-3 text-xs ${
                recentRequest.status === "pending"
                  ? "border-amber-200 bg-amber-50 text-amber-700"
                  : recentRequest.status === "approved"
                    ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                    : "border-rose-200 bg-rose-50 text-rose-700"
              }`}
            >
              <div className="mb-1 flex items-center justify-between gap-2">
                <span className="font-semibold">
                  최근 비밀번호 변경 요청 상태
                </span>
                <span className="rounded-full bg-white/80 px-2 py-0.5 text-[11px] font-semibold">
                  {recentRequest.status === "pending"
                    ? "승인 대기"
                    : recentRequest.status === "approved"
                      ? "승인 완료"
                      : "반려"}
                </span>
              </div>
              <div>
                요청 시각:{" "}
                {new Date(recentRequest.createdAt).toLocaleString("ko-KR")}
              </div>
              {recentRequest.reviewedAt && (
                <div>
                  처리 시각:{" "}
                  {new Date(recentRequest.reviewedAt).toLocaleString("ko-KR")}
                </div>
              )}
              {recentRequest.rejectReason && (
                <div>반려 사유: {recentRequest.rejectReason}</div>
              )}
            </div>
          )}
          <form
            onSubmit={handleSubmit(onSubmit)}
            className="grid gap-4 text-gray-900"
          >
            <div className="grid gap-2">
              <Label htmlFor="name">이름</Label>
              <Input
                id="name"
                type="text"
                {...register("name")}
                autoComplete="off"
              />
              {errors.name && (
                <p className="text-red-500 text-xs">{errors.name.message}</p>
              )}
            </div>
            <div className="grid gap-2">
              <Label htmlFor="password">비밀번호</Label>
              <Input
                id="password"
                type="password"
                {...register("password")}
                autoComplete="current-password"
              />
              {errors.password && (
                <p className="text-red-500 text-xs">
                  {errors.password.message}
                </p>
              )}
            </div>
            {errors.root && (
              <p className="text-red-500 text-sm text-center">
                {errors.root.message}
              </p>
            )}
            <Button type="submit" className="w-full" disabled={isSubmitting}>
              {isSubmitting ? "로그인 처리 중..." : "로그인"}
            </Button>
            <button
              type="button"
              onClick={() => setIsPasswordRequestOpen((prev) => !prev)}
              className="text-sm text-blue-600 underline underline-offset-2"
            >
              비밀번호 변경 요청
            </button>
          </form>
          <div className="mt-4 text-center text-sm text-gray-900">
            아직 계정이 없으신가요?{" "}
            <a href="/signup" className="underline">
              회원가입
            </a>
          </div>
        </CardContent>
      </Card>
      {isPasswordRequestOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-sm rounded-2xl bg-white p-5 shadow-2xl">
            <div className="mb-4 flex items-start justify-between gap-3">
              <div>
                <h2 className="text-lg font-bold text-gray-900">
                  비밀번호 변경 요청
                </h2>
                <p className="mt-1 text-sm text-gray-600">
                  로그인 없이 관리자에게 비밀번호 변경을 요청할 수 있습니다.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setIsPasswordRequestOpen(false)}
                className="rounded-lg px-2 py-1 text-sm text-gray-500 hover:bg-gray-100"
              >
                닫기
              </button>
            </div>
            <form
              onSubmit={handleSubmitPasswordRequest(onSubmitPasswordRequest)}
              className="grid gap-3 text-gray-900"
            >
              <input type="hidden" {...registerPasswordRequest("name")} />
              <div className="rounded-lg bg-gray-50 px-3 py-2 text-sm text-gray-700 ring-1 ring-gray-200">
                요청 대상: {watchedName || "로그인 이름을 먼저 입력해주세요."}
              </div>
              {!watchedName && (
                <p className="text-red-500 text-xs">
                  로그인 이름을 먼저 입력해주세요.
                </p>
              )}
              <div className="grid gap-2">
                <Label htmlFor="request-current-password">현재 비밀번호</Label>
                <Input
                  id="request-current-password"
                  type="password"
                  {...registerPasswordRequest("currentPassword")}
                />
                {passwordRequestErrors.currentPassword && (
                  <p className="text-red-500 text-xs">
                    {passwordRequestErrors.currentPassword.message}
                  </p>
                )}
              </div>
              <div className="grid gap-2">
                <Label htmlFor="request-new-password">새 비밀번호</Label>
                <Input
                  id="request-new-password"
                  type="password"
                  {...registerPasswordRequest("newPassword")}
                />
                {passwordRequestErrors.newPassword && (
                  <p className="text-red-500 text-xs">
                    {passwordRequestErrors.newPassword.message}
                  </p>
                )}
              </div>
              <Button
                type="submit"
                className="w-full"
                disabled={isSubmittingPasswordRequest || !watchedName}
              >
                {isSubmittingPasswordRequest
                  ? "요청 처리 중..."
                  : "비밀번호 변경 요청 보내기"}
              </Button>
              <p className="text-xs text-amber-700">
                이미 요청 중이면 관리자 승인 후 다시 로그인해 주세요.
              </p>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
