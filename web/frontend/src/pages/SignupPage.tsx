import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import axios from "axios";
import { useNavigate } from "react-router-dom";
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

const signupSchema = z.object({
  name: z.string().min(1, "이름을 입력해주세요."),
  username: z.string().min(3, "아이디는 최소 3자 이상이어야 합니다."),
  password: z.string().min(6, "비밀번호는 최소 6자 이상이어야 합니다."),
});

type SignupSchema = z.infer<typeof signupSchema>;

export default function SignupPage() {
  const navigate = useNavigate();
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
    setError,
  } = useForm<SignupSchema>({
    resolver: zodResolver(signupSchema),
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

  const onSubmit = async (data: SignupSchema) => {
    try {
      await axios.post(`${API_BASE_URL}/api/auth/signup`, data);
      showToast(
        "가입 신청이 접수되었습니다. 관리자 승인 후 이용할 수 있어요.",
        "success"
      );
      navigate("/login");
    } catch (error: any) {
      const message =
        error.response?.data?.message ||
        "회원가입에 실패했습니다. 다시 시도해주세요.";
      setError("root", { type: "manual", message });
      showToast(message, "error");
    }
  };

  return (
    <div className="flex items-center justify-center min-h-screen bg-gray-100">
      <Card className="mx-auto max-w-sm">
        <CardHeader>
          <CardTitle className="text-2xl font-bold text-gray-900">
            회원가입
          </CardTitle>
          <CardDescription className="text-sm text-gray-600">
            새로운 계정을 만들기 위해 정보를 입력해주세요.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            onSubmit={handleSubmit(onSubmit)}
            className="grid gap-4 text-gray-900"
          >
            <div className="grid gap-2">
              <Label htmlFor="name">이름</Label>
              <Input id="name" {...register("name")} autoComplete="off" />
              {errors.name && (
                <p className="text-red-500 text-xs">{errors.name.message}</p>
              )}
            </div>
            <div className="grid gap-2">
              <Label htmlFor="username">아이디</Label>
              <Input
                id="username"
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
                autoComplete="new-password"
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
              {isSubmitting ? "가입 처리 중..." : "회원가입"}
            </Button>
          </form>
          <div className="mt-4 text-center text-sm text-gray-900">
            이미 계정이 있으신가요?{" "}
            <a href="/login" className="underline">
              로그인
            </a>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
