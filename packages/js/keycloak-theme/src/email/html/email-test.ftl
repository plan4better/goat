<#import "template.ftl" as layout>
<@layout.emailLayout artwork="verify_email.png">
    <tr>
      <td>
        <div style="${properties.titleStyle}">
          <h2>${msg("emailTestTitle")}</h2>
        </div>
      </td>
    </tr>
    <tr>
      <td>
        <div
          style="${properties.infoContentStyle}"
        >
          ${kcSanitize(msg("emailTestBodyHtml"))?no_esc}
        </div>
      </td>
    </tr>
    <#if layout.appUrl?has_content>
    <tr>
      <td align="center">
        <a
          href="${layout.appUrl}"
          style="${properties.actionButtonStyle}"
        >
          <b style="font-weight: 700">${msg("emailTestButton")}</b>
        </a>
      </td>
    </tr>
    </#if>
</@layout.emailLayout>