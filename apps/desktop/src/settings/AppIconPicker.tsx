import type { JSX } from "react";
import { useI18n } from "@/i18n";
import { APP_ICONS, knownAppIcon, type AppIconId } from "@/ui/appIcon";
import defaultIcon from "./appIcons/default.png";
import forestIcon from "./appIcons/forest.png";
import lightIcon from "./appIcons/light.png";
import midnightIcon from "./appIcons/midnight.png";
import monoIcon from "./appIcons/mono.png";
import sunsetIcon from "./appIcons/sunset.png";

/** The 64 px thumbnail of each icon; the window gets the 256 px one from Rust. */
export const APP_ICON_IMAGES: Record<AppIconId, string> = {
  default: defaultIcon,
  midnight: midnightIcon,
  light: lightIcon,
  sunset: sunsetIcon,
  forest: forestIcon,
  mono: monoIcon,
};

export type AppIconPickerProps = {
  /** The stored id; an unknown one shows the default as picked. */
  value: string;
  disabled?: boolean;
  /** id of the element that names the group. */
  labelledBy: string;
  onPick: (id: AppIconId) => void;
};

/** Settings → Appearance → App icon: the six icons as one radio group, each option named by its label. */
export function AppIconPicker({ value, disabled, labelledBy, onPick }: AppIconPickerProps): JSX.Element {
  const { t } = useI18n();
  const picked = knownAppIcon(value);
  return (
    <div className="app-icons" role="radiogroup" aria-labelledby={labelledBy}>
      {APP_ICONS.map((id) => (
        <label className="app-icon" key={id} data-icon={id}>
          <input type="radio" name="app-icon" value={id} checked={picked === id} disabled={disabled} onChange={() => onPick(id)} />
          <span className="app-icon-tile">
            <img className="app-icon-image" src={APP_ICON_IMAGES[id]} alt="" width={40} height={40} draggable={false} />
            <span className="app-icon-name">{t(`settings.appearance.appIcon.${id}`)}</span>
          </span>
        </label>
      ))}
    </div>
  );
}
