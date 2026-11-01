<#import "template.ftl" as layout>
<@layout.emailLayout artwork="verify_email.png">
    <tr>
      <td>
        <div style="${properties.titleStyle}">
          <h2>${msg("emailUpdateConfirmationTitle")}</h2>
        </div>
      </td>
    </tr>
    <tr>
      <td>
        <div
          style="${properties.infoContentStyle}"
        >
          ${kcSanitize(msg("emailUpdateConfirmationBodyHtml",link, newEmail, realmName, linkExpirationFormatter(linkExpiration)))?no_esc}
        </div>
      </td>
    </tr>
    <tr>
      <td align="center">
        <a
          href="${link}"
          style="${properties.actionButtonStyle}"
        >
          <b style="font-weight: 700">${msg("emailUpdateConfirmationButton")}</b>
        </a>
      </td>
    </tr>
</@layout.emailLayout>