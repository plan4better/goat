<#import "template.ftl" as layout>
<@layout.emailLayout artwork="reset_password.png">
    <tr>
      <td>
        <div style="${properties.titleStyle}">
          <h2>${msg("invitationEmailTitle")}</h2>
        </div>
      </td>
    </tr>
    <tr>
      <td>
        <div
          style="${properties.infoContentStyle}"
        >
            ${kcSanitize(msg("invitationEmailBodyHtml", email, realmName, orgName, inviterName, link))?no_esc}
        </div>
      </td>
    </tr>
    <tr>
      <td align="center">
        <a
          href="${link}"
          style="${properties.actionButtonStyle}"
        >
          <b style="font-weight: 700">${msg("invitationEmailButton")}</b>
        </a>
      </td>
    </tr>
</@layout.emailLayout>