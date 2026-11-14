const PATHS = {
  home: "M4 11.5 12 5l8 6.5V20h-5.5v-5h-5v5H4z",
  pay: "M4 8h13m0 0-3.5-3.5M17 8l-3.5 3.5M20 16H7m0 0 3.5-3.5M7 16l3.5 3.5",
  calendar: "M5 6.5h14v13H5zM5 10.5h14M9 4v4M15 4v4",
  people:
    "M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm-6 9c0-3.3 2.7-6 6-6s6 2.7 6 6M16 4.500a3.5 3.5 0 0 1 0 6.500M17.5 14.300c2 .8 3.5 2.8 3.5 5.2",
  search: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14Zm5-2 4 4",
  check: "m5 12.5 4.5 4.500L19 7.5",
  back: "M15 5l-7 7 7 7",
} as const;

export function Icon({ name, size = 20 }: { name: keyof typeof PATHS; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
