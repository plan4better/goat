import { useMemo } from "react";
import { useTranslation } from "react-i18next";

const orgTypes = ["", "government", "private", "non_profit", "education", "other"];

export const useOrganizationSetup = () => {
  const { t } = useTranslation(["common"]);

  const orgTypesOptions = useMemo(() => {
    return orgTypes.map((type) => {
      return {
        value: type,
        label: type ? t(`common:organization_type_options.${type}`) : "",
      };
    });
  }, [t]);

  return {
    t,
    orgTypesOptions,
  };
};
