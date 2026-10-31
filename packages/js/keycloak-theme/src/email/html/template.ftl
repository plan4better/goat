<#-- Branding from theme.properties; blank values count as unset. -->
<#assign brandName = (properties.brandName!"")?trim>
<#if !brandName?has_content><#assign brandName = "GOAT"></#if>
<#assign logoUrl = (properties.logoUrl!"")?trim>
<#assign contactUrl = (properties.contactUrl!"")?trim>
<#assign privacyUrl = (properties.privacyUrl!"")?trim>
<#assign companyName = (properties.companyName!"")?trim>
<#assign companyUrl = (properties.companyUrl!"")?trim>
<#assign appUrl = (properties.appUrl!"")?trim?remove_ending("/")>
<#assign assetsUrl = (properties.staticAssetsUrl!"")?trim?remove_ending("/")>
<#if !assetsUrl?has_content && appUrl?has_content><#assign assetsUrl = appUrl + "/assets"></#if>

<#-- A root-relative logo (as core takes it) is served by the GOAT web app. -->
<#if logoUrl?starts_with("/") && !logoUrl?starts_with("//") && appUrl?has_content><#assign logoUrl = appUrl + logoUrl></#if>

<#macro brandMark>
  <#if logoUrl?has_content>
    <img
      alt="${brandName}"
      src="${logoUrl}"
      width="228"
      style="width: 228px; max-width: 100%; height: auto; border: 0; font-size: 20px; font-weight: 800; color: #2bb381"
    />
  <#else>
    <span style="font-size: 22px; font-weight: 800; color: #2bb381">${brandName}</span>
  </#if>
</#macro>

<#-- The same layout as core's emails and the trial mails of Plan4Better's Odoo:
     one look for every mail a GOAT user gets. Pages add rows (<tr><td>) inside the card.
     artwork: file name under <assets>/img/email/, shown above the title. -->
<#macro emailLayout artwork="">
<!DOCTYPE html>
<html lang="${msg("emailLangCode")}" xmlns="http://www.w3.org/1999/xhtml" xmlns:o="urn:schemas-microsoft-com:office:office">
  <head>
    <meta http-equiv="X-UA-Compatible" content="IE=edge" />
    <meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <meta name="x-apple-disable-message-reformatting">
    <title></title>
    <!--[if mso]>
    <noscript>
      <xml>
        <o:OfficeDocumentSettings>
          <o:AllowPNG />
          <o:PixelsPerInch>96</o:PixelsPerInch>
        </o:OfficeDocumentSettings>
      </xml>
    </noscript>
    <![endif]-->
    <style>
      h2 { margin: 0; font-size: 22px; font-weight: 700; line-height: 1.3; }
      p { margin: 0 0 12px 0; }
      @media only screen and (max-width: 480px) {
        .px { padding-left: 22px !important; padding-right: 22px !important; }
      }
    </style>
  </head>
  <body style="margin: 0; padding: 0; background-color: #f3f5f4">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color: #f3f5f4">
      <tr>
        <td align="center" style="padding: 24px 12px">
          <table
            role="presentation"
            width="600"
            cellpadding="0"
            cellspacing="0"
            style="max-width: 600px; width: 100%; background-color: #ffffff; border-radius: 10px; overflow: hidden; font-family: Mulish, Arial, Helvetica, sans-serif; color: #26303b; text-align: left"
          >
            <tr>
              <td class="px" style="padding: 24px 40px 0 40px">
                <#if appUrl?has_content>
                <a href="${appUrl}" style="text-decoration: none; font-size: 20px; font-weight: 800; color: #2bb381"><@brandMark /></a>
                <#else>
                <@brandMark />
                </#if>
              </td>
            </tr>
            <#if artwork?has_content && assetsUrl?has_content>
            <tr>
              <td class="px" align="center" style="padding: 20px 40px 0 40px">
                <img alt="" src="${assetsUrl}/img/email/${artwork}" width="260" style="width: 260px; max-width: 100%; height: auto; border: 0" />
              </td>
            </tr>
            </#if>
            <#nested>
            <tr>
              <td style="padding: 0 0 28px 0; font-size: 0; line-height: 0">&nbsp;</td>
            </tr>
            <tr>
              <td style="height: 4px; background-color: #2bb381; font-size: 0; line-height: 0">&nbsp;</td>
            </tr>
          </table>
          <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width: 600px; width: 100%">
            <tr>
              <td style="padding: 14px 40px; font-family: Arial, Helvetica, sans-serif; font-size: 12px; line-height: 1.5; color: #5f6b76; text-align: center">
                ${msg("accountEmailNote")}<br />
                <#if companyName?has_content>
                <#if companyUrl?has_content><a href="${companyUrl}" style="color: #5f6b76">${companyName}</a><#else>${companyName}</#if>
                <#else>
                &copy; ${brandName} ${.now?string("yyyy")}
                </#if>
                <#if privacyUrl?has_content || contactUrl?has_content><br /></#if>
                <#if privacyUrl?has_content><a href="${privacyUrl}" style="color: #5f6b76">${msg("privacy")}</a></#if>
                <#if privacyUrl?has_content && contactUrl?has_content> &middot; </#if>
                <#if contactUrl?has_content><a href="${contactUrl}" style="color: #5f6b76">${msg("contactUs")}</a></#if>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>
</#macro>
