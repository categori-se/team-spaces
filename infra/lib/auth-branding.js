// @ts-check

import {readFileSync} from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultAssetDirectory = path.resolve(dirname, "../assets/auth");
const maximumAssetBytes = 1_000_000;

const assetDefinitions = [
  {category: "FORM_LOGO", colorMode: "LIGHT", filename: "team-spaces-logo-light.svg"},
  {category: "FORM_LOGO", colorMode: "DARK", filename: "team-spaces-logo-dark.svg"},
  {category: "FAVICON_SVG", colorMode: "DYNAMIC", filename: "team-spaces-favicon.svg"}
];

/**
 * @param {string} prefix
 * @param {string} region
 */
export function cognitoManagedLoginUrl(prefix, region) {
  const authLabel = region.startsWith("us-gov-") ? "auth-fips" : "auth";
  const domainSuffix = region.startsWith("cn-") ? "amazoncognito.com.cn" : "amazoncognito.com";
  return `https://${prefix}.${authLabel}.${region}.${domainSuffix}`;
}

/**
 * Managed Login uses eight-character RGBA values without a leading '#'.
 * These values mirror the neutral Team Spaces light and dark application
 * themes in apps/web/src/styles/theme.css.
 */
export const teamSpacesManagedLoginSettings = {
  categories: {
    form: {
      displayGraphics: true,
      location: {horizontal: "CENTER", vertical: "CENTER"}
    },
    global: {
      colorSchemeMode: "DYNAMIC",
      pageFooter: {enabled: false},
      pageHeader: {enabled: false},
      spacingDensity: "REGULAR"
    }
  },
  componentClasses: {
    buttons: {borderRadius: 6},
    divider: {
      darkMode: {borderColor: "3a4655ff"},
      lightMode: {borderColor: "dfe5eaff"}
    },
    focusState: {
      darkMode: {borderColor: "8b9cffff"},
      lightMode: {borderColor: "5267d8ff"}
    },
    input: {
      borderRadius: 6,
      darkMode: {
        defaults: {backgroundColor: "182332ff", borderColor: "657284ff"},
        placeholderColor: "97a1adff"
      },
      lightMode: {
        defaults: {backgroundColor: "ffffffff", borderColor: "7b8794ff"},
        placeholderColor: "596273ff"
      }
    },
    inputDescription: {
      darkMode: {textColor: "c5cbd2ff"},
      lightMode: {textColor: "596273ff"}
    },
    inputLabel: {
      darkMode: {textColor: "f8fafcff"},
      lightMode: {textColor: "151923ff"}
    },
    link: {
      darkMode: {
        defaults: {textColor: "60a5faff"},
        hover: {textColor: "93c5fdff"}
      },
      lightMode: {
        defaults: {textColor: "176fa8ff"},
        hover: {textColor: "115680ff"}
      }
    },
    optionControls: {
      darkMode: {
        defaults: {backgroundColor: "182332ff", borderColor: "657284ff"},
        selected: {backgroundColor: "2dd4bfff", foregroundColor: "0b1018ff"}
      },
      lightMode: {
        defaults: {backgroundColor: "ffffffff", borderColor: "7b8794ff"},
        selected: {backgroundColor: "12836fff", foregroundColor: "ffffffff"}
      }
    }
  },
  components: {
    alert: {
      borderRadius: 6,
      darkMode: {error: {backgroundColor: "2b171dff", borderColor: "fb7185ff"}},
      lightMode: {error: {backgroundColor: "fff4f2ff", borderColor: "d95d4fff"}}
    },
    favicon: {enabledTypes: ["SVG"]},
    form: {
      backgroundImage: {enabled: false},
      borderRadius: 8,
      darkMode: {backgroundColor: "101720ff", borderColor: "3a4655ff"},
      lightMode: {backgroundColor: "ffffffff", borderColor: "dfe5eaff"},
      logo: {enabled: true, formInclusion: "IN", location: "CENTER", position: "TOP"}
    },
    pageBackground: {
      darkMode: {color: "0b1018ff"},
      image: {enabled: false},
      lightMode: {color: "fbfcfbff"}
    },
    pageText: {
      darkMode: {bodyColor: "c5cbd2ff", descriptionColor: "c5cbd2ff", headingColor: "f8fafcff"},
      lightMode: {bodyColor: "596273ff", descriptionColor: "596273ff", headingColor: "151923ff"}
    },
    primaryButton: {
      darkMode: {
        active: {backgroundColor: "5eead4ff", textColor: "0b1018ff"},
        defaults: {backgroundColor: "2dd4bfff", textColor: "0b1018ff"},
        disabled: {backgroundColor: "31544fff", borderColor: "31544fff"},
        hover: {backgroundColor: "5eead4ff", textColor: "0b1018ff"}
      },
      lightMode: {
        active: {backgroundColor: "07594dff", textColor: "ffffffff"},
        defaults: {backgroundColor: "12836fff", textColor: "ffffffff"},
        disabled: {backgroundColor: "b8d2ccff", borderColor: "b8d2ccff"},
        hover: {backgroundColor: "0b6f60ff", textColor: "ffffffff"}
      }
    },
    secondaryButton: {
      darkMode: {
        active: {backgroundColor: "182332ff", borderColor: "93c5fdff", textColor: "93c5fdff"},
        defaults: {backgroundColor: "101720ff", borderColor: "60a5faff", textColor: "60a5faff"},
        hover: {backgroundColor: "182332ff", borderColor: "93c5fdff", textColor: "93c5fdff"}
      },
      lightMode: {
        active: {backgroundColor: "edf7ffff", borderColor: "115680ff", textColor: "115680ff"},
        defaults: {backgroundColor: "ffffffff", borderColor: "176fa8ff", textColor: "176fa8ff"},
        hover: {backgroundColor: "edf7ffff", borderColor: "115680ff", textColor: "115680ff"}
      }
    }
  }
};

/**
 * @param {string} assetDirectory
 * @param {string} filename
 */
function base64Svg(assetDirectory, filename) {
  const assetPath = path.join(assetDirectory, filename);
  let bytes;
  try {
    bytes = readFileSync(assetPath);
  } catch (error) {
    throw new Error(`Unable to read Cognito branding asset ${assetPath}`, {cause: error});
  }
  if (bytes.length === 0 || bytes.length >= maximumAssetBytes) {
    throw new Error(`Cognito branding asset ${assetPath} must be between 1 and ${maximumAssetBytes - 1} bytes`);
  }
  if (!/^<svg(?:\s|>)/u.test(bytes.toString("utf8").trimStart())) {
    throw new Error(`Cognito branding asset ${assetPath} must be an SVG document`);
  }
  return bytes.toString("base64");
}

/**
 * Load the three fixed Cognito branding assets. A hosted operator can supply
 * an absolute asset directory without forking or patching the community core.
 * The directory must contain team-spaces-logo-light.svg,
 * team-spaces-logo-dark.svg, and team-spaces-favicon.svg.
 *
 * @param {{assetDirectory?: string}} [options]
 */
export function teamSpacesManagedLoginAssets(options = {}) {
  const assetDirectory = options.assetDirectory ?? defaultAssetDirectory;
  if (typeof assetDirectory !== "string" || !path.isAbsolute(assetDirectory)) {
    throw new Error("Cognito branding assetDirectory must be an absolute path");
  }
  return assetDefinitions.map(({category, colorMode, filename}) => ({
    category,
    colorMode,
    extension: "SVG",
    bytes: base64Svg(assetDirectory, filename)
  }));
}
