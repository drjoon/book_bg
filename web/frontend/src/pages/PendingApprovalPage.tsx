import { Link, useLocation } from "react-router-dom";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";

export default function PendingApprovalPage() {
  const location = useLocation();
  const name = (location.state as { name?: string } | undefined)?.name;

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-100 px-4">
      <Card className="mx-auto max-w-md">
        <CardHeader>
          <CardTitle className="text-2xl font-bold text-gray-900">
            승인 대기 중
          </CardTitle>
          <CardDescription className="text-sm text-gray-600">
            가입 신청은 완료되었지만 아직 관리자 승인이 되지 않았습니다.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 text-gray-900">
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            {name
              ? `${name} 계정은 승인 후 로그인할 수 있습니다.`
              : "관리자가 계정을 승인하면 바로 로그인할 수 있습니다."}
          </div>
          <div className="space-y-1 text-sm text-gray-600">
            <p>운영 방식은 비공개 승인제입니다.</p>
            <p>관리자 계정에서 사용자 승인 후 서비스 이용이 가능합니다.</p>
          </div>
          <div className="flex justify-end gap-2">
            <Link to="/signup">
              <Button type="button" variant="outline">
                회원가입으로 돌아가기
              </Button>
            </Link>
            <Link to="/login">
              <Button type="button">로그인 화면</Button>
            </Link>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
