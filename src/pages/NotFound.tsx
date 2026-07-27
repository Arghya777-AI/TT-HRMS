import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <div className="grid min-h-dvh place-items-center bg-background p-6 text-center">
      <div>
        <p className="font-display text-6xl font-bold text-brand-terracotta">404</p>
        <h1 className="mt-2 font-display text-2xl font-semibold">This path isn't on the roster</h1>
        <p className="mt-2 text-muted-foreground">The page you're looking for doesn't exist.</p>
        <Button asChild className="mt-6">
          <Link to="/">Back to home</Link>
        </Button>
      </div>
    </div>
  );
}
