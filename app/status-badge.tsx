import {
  Archive,
  Ban,
  CircleCheck,
  CircleDashed,
  CircleHelp,
  CircleMinus,
  CircleX,
  Clock,
  FileText,
  KeyRound,
  MessageCircleQuestion,
  RotateCw,
  ShieldQuestion,
  SkipForward,
  Stamp,
  type LucideIcon,
} from "lucide-react";
import { BADGE_LABELS, type BadgeTone } from "@/lib/applications/badges";

// The glyph carries the meaning too, so a badge never depends on telling two tints apart.
const GLYPHS: Record<BadgeTone, LucideIcon> = {
  queued: Clock,
  progress: CircleDashed,
  answer: MessageCircleQuestion,
  document: FileText,
  approval: Stamp,
  login: KeyRound,
  verification: ShieldQuestion,
  retry: RotateCw,
  unsupported: Ban,
  unknown: CircleHelp,
  applied: CircleCheck,
  failed: CircleX,
  skipped: SkipForward,
  cancelled: CircleMinus,
  archived: Archive,
};

/** A status label, not a control: tinted fill and a glyph, where a pressable `.chip` has a border. */
export function StatusBadge({
  tone,
  label = BADGE_LABELS[tone],
}: {
  tone: BadgeTone;
  label?: string;
}) {
  const Glyph = GLYPHS[tone];
  return (
    <span className="badge" data-tone={tone}>
      <Glyph size={12} strokeWidth={1.25} absoluteStrokeWidth aria-hidden />
      {label}
    </span>
  );
}

export function CountBadge({ count }: { count: number }) {
  return <span className="count-badge nums">{count}</span>;
}
