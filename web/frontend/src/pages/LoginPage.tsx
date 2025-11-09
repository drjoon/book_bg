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

const loginSchema = z.object({
  username: z.string().min(1, "아이디를 입력해주세요."),
  password: z.string().min(1, "비밀번호를 입력해주세요."),
});

type LoginSchema = z.infer<typeof loginSchema>;

export default function LoginPage() {
  const navigate = useNavigate();
  const login = useAuthStore((state) => state.login);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
    setError,
  } = useForm<LoginSchema>({
    resolver: zodResolver(loginSchema),
  });

  const showToast = (
    message: string,
    type: "success" | "error" | "info" = "info"
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
      const message =
        error.response?.data?.message ||
        "로그인에 실패했습니다. 입력 정보를 확인해주세요.";
      setError("root", { type: "manual", message });
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
            서비스 이용을 위해 아이디와 비밀번호를 입력해주세요.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            onSubmit={handleSubmit(onSubmit)}
            className="grid gap-4 text-gray-900"
          >
            <div className="grid gap-2">
              <Label htmlFor="username">아이디</Label>
              <Input
                id="username"
                type="text"
                {...register("username")}
                autoComplete="off"
              />
              {errors.username && (
                <p className="text-red-500 text-xs">
                  {errors.username.message}
                </p>
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
          </form>
          <div className="mt-4 text-center text-sm text-gray-900">
            아직 계정이 없으신가요?{" "}
            <a href="/signup" className="underline">
              회원가입
            </a>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
