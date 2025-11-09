import * as React from "react";
import { cn } from "./utils";

type LabelProps = React.LabelHTMLAttributes<HTMLLabelElement> & {
  requiredIndicator?: boolean;
};

export const Label = React.forwardRef<HTMLLabelElement, LabelProps>(
  ({ className, children, requiredIndicator, ...props }, ref) => {
    return (
      <label
        ref={ref}
        className={cn(
          "text-sm font-semibold text-gray-900 leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70",
          className
        )}
        {...props}
      >
        {children}
        {requiredIndicator ? <span className="ml-1 text-red-500">*</span> : null}
      </label>
    );
  }
);
Label.displayName = "Label";
